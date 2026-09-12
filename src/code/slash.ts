import { incrementalIndex, readIndex, workspaceHash } from "./indexer.ts";
import { findSymbols } from "./find.ts";
import type { Index } from "./indexer.ts";

let indexing = false;

export function isCodeCommand(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "/index" || trimmed.startsWith("/find ");
}

/**
 * Run a code slash command. Returns true if handled.
 * onProgress pushes progress text into io.push during indexing.
 */
export async function runCodeSlash(
  line: string,
  io: { roots: Record<string, string>; push: (node: any) => void },
): Promise<boolean> {
  const trimmed = line.trim();
  if (trimmed === "/index") {
    if (indexing) { io.push({ type: "text", text: "index already running" }); return true; }
    indexing = true;
    const roots = new Map(Object.entries(io.roots));
    try {
      const hash = workspaceHash(roots);
      const existing = readIndex(hash);
      if (existing) {
        io.push({ type: "text", text: "index already up to date" });
        indexing = false;
        return true;
      }
      const summary = await incrementalIndex(roots, (p) => {
        const suffix = p.heuristic > 0 ? " (heuristic — tree-sitter wasm not found)" : "";
        io.push({ type: "text", text: `indexed ${p.done} files · ${p.symbols} symbols${suffix}` });
      });
      const hint = summary.heuristicFiles > 0 ? " (heuristic — tree-sitter wasm not found)" : "";
      io.push({ type: "text", text: `force-reindexed ${summary.files} files · ${summary.symbols} symbols${hint}` });
    } catch (e: any) {
      io.push({ type: "text", text: `index error: ${e?.message ?? e}` });
    }
    indexing = false;
    return true;
  }

  if (trimmed.startsWith("/find ")) {
    const query = trimmed.slice(6).trim();
    const roots = new Map(Object.entries(io.roots));
    const hash = workspaceHash(roots);
    const index = readIndex(hash);
    if (!index || Object.keys(index.files).length === 0) {
      if (Object.keys(roots).length === 0) {
        io.push({ type: "text", text: "no index yet — run /index" });
      } else {
        io.push({ type: "text", text: `no index yet — run /index for repo(s): ${Object.keys(roots).join(", ")}` });
      }
      return true;
    }
    const results = findSymbols(index, query, { limit: 12 });
    if (results.length === 0) { io.push({ type: "text", text: "(no matches)" }); return true; }
    for (const r of results) {
      const heur = r.heuristic ? " [heuristic]" : "";
      io.push({ type: "text", text: `${r.kind} ${r.name}  ${r.file}:${r.line}${heur}` });
    }
    io.push({ type: "text", text: `${results.length} result(s)` });
    return true;
  }

  return false;
}

/**
 * Auto-index: no-op if an index file exists for the workspace hash,
 * otherwise one incremental pass. Never throws (swallows + onProgress note).
 */
export async function autoIndexOnce(
  roots: Map<string, string>,
  onProgress?: (p: { done: number; total: number; files: number; symbols: number; heuristic: number }) => void,
): Promise<void> {
  try {
    const hash = workspaceHash(roots);
    const existing = readIndex(hash);
    if (existing) return; // no-op — index already exists
    await incrementalIndex(roots, onProgress);
  } catch {
    // swallow — spec says never throws
  }
}
