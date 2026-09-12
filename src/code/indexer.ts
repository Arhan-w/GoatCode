/**
 * Incremental workspace symbol index. One JSON file per workspace hash under
 * <appDir()>/index/<hash>.json:
 *   { files: { "<repo>/<relpath>": {repo,hash,mtime,size,symbols,imports,heuristic?} },
 *     edges: [{caller,callee,repo,file,line}] }
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { appDir } from "../config.ts";
import { SKIP_DIRS } from "../tools.ts";
import { extractFile, type ParserLike } from "./extract.ts";

export interface IndexFile {
  repo: string;
  hash: string;
  mtime: number;
  size: number;
  symbols: { name: string; kind: string; line: number }[];
  imports: string[];
  heuristic?: true;
}
export interface IndexEdge {
  caller: string;
  callee: string;
  repo: string;
  file: string;
  line: number;
}
export interface Index {
  files: Record<string, IndexFile>;
  edges: IndexEdge[];
}

export interface IndexProgress {
  done: number;
  total: number;
  files: number;
  symbols: number;
  heuristic: number;
}
export interface IndexSummary {
  files: number;
  symbols: number;
  edges: number;
  heuristicFiles: number;
  ms: number;
  indexPath: string;
}

export const MAX_INDEX_FILE_BYTES = 1_000_000;
const BATCH_SIZE = 200;

/** First 16 hex of sha256 over sorted "name=abs" lines joined by \n. */
export function workspaceHash(roots: Map<string, string>): string {
  const lines = [...roots.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, abs]) => `${name}=${abs}`)
    .join("\n");
  return createHash("sha256").update(lines).digest("hex").slice(0, 16);
}

export function indexPathFor(hash: string): string {
  const dir = join(appDir(), "index");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}.json`);
}

export function readIndex(hash: string): Index | null {
  try {
    const raw = JSON.parse(readFileSync(indexPathFor(hash), "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.files !== "object") return null;
    return { files: raw.files, edges: Array.isArray(raw.edges) ? raw.edges : [] };
  } catch {
    return null;
  }
}

export function clearIndex(hash: string): void {
  try { unlinkSync(indexPathFor(hash)); } catch { /* ok if missing */ }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Binary sniff: NUL byte in the first 8KB. */
function isBinaryHead(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walkRoot(root: string, onFile: (abs: string, rel: string) => void): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkRoot(join(root, e.name), onFile);
    } else if (e.isFile()) {
      onFile(join(root, e.name), relative(root, join(root, e.name)).replaceAll("\\", "/"));
    }
  }
}

/**
 * Incremental pass over every root (SKIP_DIRS honored, >1MB/binary skipped).
 * Fast path: unchanged mtime+size keeps the prior entry with zero parse work.
 * Otherwise content is hashed; unchanged content still re-stamps mtime but
 * skips re-parsing; changed content reparses and replaces that file's edges.
 * Deleted files (and their edges) are pruned. Persisted every 200-file batch
 * and at the end, yielding with setImmediate so the TUI never blocks.
 */
export async function incrementalIndex(
  roots: Map<string, string>,
  onProgress?: (p: IndexProgress) => void,
  opts: { force?: boolean; parserFactory?: (grammar: string) => Promise<ParserLike> } = {},
): Promise<IndexSummary> {
  const t0 = Date.now();
  const hash = workspaceHash(roots);
  const ipath = indexPathFor(hash);
  const prior = opts.force ? null : readIndex(hash);
  const priorEdges = new Map<string, IndexEdge[]>();
  for (const e of prior?.edges ?? []) {
    if (!priorEdges.has(e.file)) priorEdges.set(e.file, []);
    priorEdges.get(e.file)!.push(e);
  }

  const nextFiles: Record<string, IndexFile> = {};
  const nextEdges = new Map<string, IndexEdge[]>();

  const candidates: { key: string; repo: string; abs: string }[] = [];
  for (const [repo, root] of roots) {
    walkRoot(root, (abs, rel) => {
      const i = rel.lastIndexOf(".");
      if (i < 0) return;
      candidates.push({ key: `${repo}/${rel}`, repo, abs });
    });
  }

  const total = candidates.length;
  let done = 0;
  let lastTick = 0;

  const snapshot = (): Index => ({
    files: nextFiles,
    edges: [...nextEdges.values()].flat(),
  });

  for (const { key, repo, abs } of candidates) {
    done++;
    try {
      const st = statSync(abs);
      if (st.size > MAX_INDEX_FILE_BYTES) continue;
      const buf = readFileSync(abs);
      if (isBinaryHead(buf)) continue;
      const content = buf.toString("utf8");
      const prev = prior?.files[key];

      // fast path — mtime+size unchanged keeps the prior entry untouched
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
        nextFiles[key] = prev;
        if (priorEdges.has(key)) nextEdges.set(key, priorEdges.get(key)!);
      } else {
        const contentHash = hashContent(content);
        if (prev && prev.hash === contentHash && !opts.force) {
          // content unchanged: re-stamp stat only, zero parse work
          nextFiles[key] = { ...prev, mtime: st.mtimeMs, size: st.size };
          if (priorEdges.has(key)) nextEdges.set(key, priorEdges.get(key)!);
        } else {
          const extracted = await extractFile(abs, content, opts.parserFactory);
          nextFiles[key] = {
            repo,
            hash: contentHash,
            mtime: st.mtimeMs,
            size: st.size,
            symbols: extracted.symbols,
            imports: extracted.imports,
            ...(extracted.heuristic ? { heuristic: true as const } : {}),
          };
          // changed file: its old edges are dropped and replaced
          nextEdges.set(key, extracted.edges.map((e) => ({
            caller: e.caller, callee: e.callee, repo, file: key, line: e.line,
          })));
        }
      }
    } catch { /* unreadable file: skip */ }

    if (done - lastTick >= BATCH_SIZE) {
      lastTick = done;
      persist(ipath, snapshot());
      await tick(onProgress, done, total, snapshot());
    }
  }

  const final = snapshot();
  persist(ipath, final);
  await tick(onProgress, done, total, final);

  let symbols = 0;
  let heuristicFiles = 0;
  for (const f of Object.values(final.files)) {
    symbols += f.symbols.length;
    if (f.heuristic) heuristicFiles++;
  }
  return {
    files: Object.keys(final.files).length,
    symbols,
    edges: final.edges.length,
    heuristicFiles,
    ms: Date.now() - t0,
    indexPath: ipath,
  };
}

function persist(ipath: string, index: Index): void {
  const dir = dirname(ipath);
  mkdirSync(dir, { recursive: true });
  const tmp = ipath + ".tmp";
  writeFileSync(tmp, JSON.stringify(index), "utf8");
  renameSync(tmp, ipath);
}

async function tick(
  onProgress: ((p: IndexProgress) => void) | undefined,
  done: number,
  total: number,
  index: Index,
): Promise<void> {
  if (onProgress) {
    let files = 0, symbols = 0, heuristic = 0;
    for (const f of Object.values(index.files)) {
      files++; symbols += f.symbols.length;
      if (f.heuristic) heuristic++;
    }
    onProgress({ done, total, files, symbols, heuristic });
  }
  await new Promise((r) => setImmediate(r));
}
