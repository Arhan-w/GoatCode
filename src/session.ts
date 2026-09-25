/**
 * JSONL session persistence: ~/.goatcode/sessions/<id>.jsonl
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./config.ts";
import type { Message, ToolCall } from "./llm.ts";
import { textOf } from "./llm.ts";
import { SessionError } from "./errors.ts";

export interface SubagentFork {
  childId: string;
  description: string;
  explore: boolean;
  startedAt: number;
  completedAt?: number;
  stepsUsed?: number;
  error?: string;
}

export interface SnapRecord {
  path: string;
  before: string;
  after: string;
  turnIndex: number;
}

export interface SessionData {
  id: string;
  cwd: string;
  model: string;
  title: string;
  createdAt: number;
  usage: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  /** Message-count at the start of each user turn (for /rewind). */
  turnMarks?: number[];
  messages: Message[];
  compactedFrom: number;
  /** Model-written (or digest-fallback) summary of everything before compactedFrom. */
  digest: string;
  /** Subagent fork metadata: tracks child sessions spawned from this one. */
  subagentForks?: SubagentFork[];
  /** Crash recovery marker: set at turn start, cleared on successful completion. */
  crashRecoveryMarker?: {
    turnIndex: number;
    startedAt: number;
    pendingTools: Array<{ tool: string; args: any; callId: string }>;
  };
  /** Tool state snapshots for crash recovery. */
  toolState?: {
    snapshots: SnapRecord[];
    completedTurns: number;
  };
}

function sessionsDir(): string {
  const d = join(appDir(), "sessions");
  mkdirSync(d, { recursive: true });
  return d;
}

function newId(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // random suffix — two Session.new() calls in the same second must not collide
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}${rnd}`;
}

export class Session {
  id: string;
  cwd: string;
  model: string;
  title = "";
  createdAt: number;
  messages: Message[] = [];
  compactedFrom = 0;
  usage: { in: number; out: number; cacheRead?: number; cacheWrite?: number } = { in: 0, out: 0 };
  digest = "";
  /** Message-count at the start of each user turn (drives /rewind). */
  turnMarks: number[] = [];
  /** Subagent fork metadata: child sessions spawned from this parent. */
  subagentForks: SubagentFork[] = [];
  /** Crash recovery marker: set at turn start, cleared on successful completion. */
  crashRecoveryMarker?: {
    turnIndex: number;
    startedAt: number;
    pendingTools: Array<{ tool: string; args: any; callId: string }>;
  };
  /** Tool state snapshots for crash recovery. */
  toolState: { snapshots: SnapRecord[]; completedTurns: number } = { snapshots: [], completedTurns: 0 };

  // Append-only save thresholds
  private _saveCount = 0;
  private static readonly COMPACT_THRESHOLD = 500; // messages
  private static readonly COMPACT_SIZE_THRESHOLD = 1_000_000; // bytes

  constructor(init: Partial<SessionData> & { id: string; cwd: string; model: string }) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.title = init.title ?? "";
    this.createdAt = init.createdAt ?? Date.now() / 1000;
    this.messages = init.messages ?? [];
    this.compactedFrom = init.compactedFrom ?? 0;
    const u = init.usage ?? { in: 0, out: 0 };
    this.usage = { in: u.in ?? 0, out: u.out ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
    this.digest = init.digest ?? "";
    this.turnMarks = Array.isArray(init.turnMarks) ? init.turnMarks : [];
    this.subagentForks = Array.isArray(init.subagentForks) ? init.subagentForks : [];
    this.crashRecoveryMarker = init.crashRecoveryMarker;
    this.toolState = init.toolState ?? { snapshots: [], completedTurns: 0 };
  }

  addSubagentFork(fork: SubagentFork): void {
    this.subagentForks.push(fork);
  }

  completeSubagentFork(childId: string, info: { stepsUsed: number; error?: string }): void {
    const fork = this.subagentForks.find((f) => f.childId === childId);
    if (fork) {
      fork.completedAt = Date.now();
      fork.stepsUsed = info.stepsUsed;
      fork.error = info.error;
    }
  }

  static new(cwd: string, model: string): Session {
    return new Session({ id: newId(), cwd, model });
  }

  /**
   * Fork this session — creates a new session that shares all messages
   * up to the current point, allowing branching conversation paths.
   */
  fork(name?: string): Session {
    const forkId = `fork-${newId()}`;
    const forkedSession = new Session({
      id: forkId,
      cwd: this.cwd,
      model: this.model,
      messages: [...this.messages],
      compactedFrom: this.compactedFrom,
      digest: this.digest,
      turnMarks: [...this.turnMarks],
      title: name ?? `${this.title} (branch)`,
      createdAt: Date.now() / 1000,
      usage: { ...this.usage },
    });

    // Record the branch point in parent
    this.subagentForks.push({
      childId: forkId,
      description: name ?? `Branch at ${new Date().toISOString().slice(0, 16)}`,
      explore: false,
      startedAt: Date.now(),
    });

    return forkedSession;
  }

  static loadById(id: string): Session {
    const s = new Session({ id, cwd: process.cwd(), model: "" });
    s.load();
    return s;
  }

  private path(): string {
    return join(sessionsDir(), `${this.id}.jsonl`);
  }

  append(msg: Message): void {
    this.messages.push(msg);
  }

  /** Append-only save: write new messages as JSONL, compact periodically */
  async save(): Promise<void> {
    if (this.messages.length === 0) return;

    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    const path = this.path();

    // Determine which messages to write (everything after compactedFrom)
    const messagesToWrite = this.messages.slice(this.compactedFrom);
    if (messagesToWrite.length === 0) return;

    // Append JSONL with version header
    const header = JSON.stringify({ version: 'jsonl', id: this.id, compactedFrom: this.compactedFrom });
    const body = messagesToWrite.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await Bun.file(path, { create: true, open: 'a' }).write(header + '\n' + body);

    this._saveCount++;

    // Compact if needed
    if (this.shouldCompact()) {
      await this.compact();
    }
  }

  private shouldCompact(): boolean {
    const remaining = this.messages.length - this.compactedFrom;
    if (remaining >= Session.COMPACT_THRESHOLD) return true;

    // Check file size
    try {
      const stats = Bun.file(this.path()).statSync();
      return stats.size > Session.COMPACT_SIZE_THRESHOLD;
    } catch {
      return false;
    }
  }

  /** Rewrite full session as single JSON (compacted) */
  async compact(): Promise<void> {
    if (this.messages.length <= this.compactedFrom) return;

    // Summarize old messages
    const oldMessages = this.messages.slice(0, this.compactedFrom);
    const digest = oldMessages.length > 0 ? await summarize(oldMessages) : '';

    // Write compacted form
    const data = {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      title: this.title,
      createdAt: this.createdAt,
      usage: this.usage,
      turnMarks: this.turnMarks,
      messages: this.messages.slice(this.compactedFrom),
      compactedFrom: 0,
      digest,
      compactedAt: Date.now()
    };

    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    await Bun.file(this.path()).write(JSON.stringify(data) + '\n');

    this.compactedFrom = 0;
    this._saveCount = 0;
  }

  /** Load handles both JSONL and compact formats */
  async load(): Promise<void> {
    const path = this.path();
    try {
      const content = await Bun.file(path).text();
      const lines = content.trim().split('\n').filter(Boolean);

      // Try compact JSON format first (header line starts with { and no version field, or has compactedFrom at top)
      try {
        const data = JSON.parse(lines[0]);
        if (data.messages && Array.isArray(data.messages) && !data.version) {
          this.messages = data.messages;
          this.compactedFrom = data.compactedFrom ?? 0;
          this.digest = data.digest ?? '';
          return;
        }
      } catch {
        // Not compact JSON, try JSONL
      }

      // JSONL format: first line is version header
      try {
        const header = JSON.parse(lines[0]);
        if (header.version === 'jsonl') {
          this.messages = lines.slice(1).map(l => JSON.parse(l));
          this.compactedFrom = header.compactedFrom ?? 0;
          this.digest = header.digest ?? '';
          return;
        }
        // If header is not jsonl version, treat as compact JSON fallback
        if (header.messages && Array.isArray(header.messages)) {
          this.messages = header.messages;
          this.compactedFrom = header.compactedFrom ?? 0;
          this.digest = header.digest ?? '';
          return;
        }
      } catch {
        // Not JSONL either
      }

      // Legacy: all lines are messages (no version header at all)
      this.messages = lines.map(l => JSON.parse(l));
      this.compactedFrom = 0;
    } catch {
      // File doesn't exist or is corrupt - keep existing state
    }
  }

  /** The window sent to the provider: everything after the compaction cut. */
  context(): Message[] {
    return this.messages.slice(this.compactedFrom);
  }

  /** Mark start of a turn (for crash recovery). */
  markTurnStart(turnIndex: number, pendingTools?: Array<{ tool: string; args: any; callId: string }>): void {
    this.crashRecoveryMarker = {
      turnIndex,
      startedAt: Date.now(),
      pendingTools: pendingTools ?? []
    };
  }

  /** Clear recovery marker on successful turn completion. */
  clearTurnMarker(): void {
    this.crashRecoveryMarker = undefined;
  }

  /** Check if session has pending work from a crash (stale after 1 min). */
  hasPendingTurn(): boolean {
    return this.crashRecoveryMarker !== undefined &&
      Date.now() - this.crashRecoveryMarker.startedAt > 60_000;
  }

  /** Recover from crash by replaying tool calls. */
  async recover(): Promise<{ recovered: boolean; tools: Array<{ tool: string; args: any }> }> {
    if (!this.crashRecoveryMarker?.pendingTools) {
      return { recovered: false, tools: [] };
    }
    return {
      recovered: true,
      tools: this.crashRecoveryMarker.pendingTools.map((t) => ({ tool: t.tool, args: t.args })),
    };
  }
}

export function listSessions(): { id: string; model: string; title: string }[] {
  const dir = sessionsDir();
  const out: { id: string; model: string; title: string }[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    try {
      const first = readFileSync(join(dir, f), "utf8").split("\n", 1)[0];
      const meta = JSON.parse(first);
      if (meta.meta) out.push({ id: meta.id, model: meta.model ?? "", title: meta.title ?? "" });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

export interface SessionSummary {
  id: string;
  model: string;
  title: string;
  cwd: string;
  createdAt: number;   // unix seconds
  usage: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  /** Message-count at the start of each user turn (for /rewind). */
  turnMarks?: number[];
  /** Parent session ID (if this session was forked from another). */
  parentId?: string;
}

/** Session branch metadata — tracks fork relationships */
export interface SessionBranch {
  /** Unique ID for this branch point */
  branchId: string;
  /** Session ID of the parent */
  parentId: string;
  /** Branch name/description */
  name: string;
  /** Timestamp when forked */
  forkedAt: number;
  /** Number of messages at fork point */
  forkMessageCount: number;
}

/** Every stored session's meta line — feeds the cost dashboard. */
export function allSessions(): SessionSummary[] {
  const dir = sessionsDir();
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    try {
      const first = readFileSync(join(dir, f), "utf8").split("\n", 1)[0];
      const meta = JSON.parse(first);
      if (meta.meta) out.push({
        id: meta.id, model: meta.model ?? "", title: meta.title ?? "",
        cwd: meta.cwd ?? "", createdAt: meta.createdAt ?? 0,
        usage: { cacheRead: 0, cacheWrite: 0, ...(meta.usage ?? {}) },
        turnMarks: Array.isArray(meta.turnMarks) ? meta.turnMarks : [],
      });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Full-text search across saved sessions (user + assistant text). Case-
 * insensitive substring; newest-first; corrupt files skipped.
 */
export interface SessionHit {
  id: string; title: string; model: string; createdAt: number;
  snippet: string; hits: number;
}

export function searchSessions(query: string, limit = 20): SessionHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const dir = sessionsDir();
  const out: SessionHit[] = [];
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  for (const f of files) {
    try {
      const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
      let title = "", model = "", createdAt = 0, id = f.replace(/\.jsonl$/, "");
      let hits = 0;
      let snippet = "";
      for (const line of lines) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.meta) { title = obj.title ?? ""; model = obj.model ?? ""; createdAt = obj.createdAt ?? 0; id = obj.id ?? id; continue; }
        if (obj.role !== "user" && obj.role !== "assistant") continue;
        const text = typeof obj.content === "string" ? obj.content
          : Array.isArray(obj.content) ? obj.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ") : "";
        const low = text.toLowerCase();
        let pos = low.indexOf(q), count = 0;
        while (pos !== -1) { count++; pos = low.indexOf(q, pos + q.length); }
        if (!count) continue;
        hits += count;
        if (!snippet) {
          const at = low.indexOf(q);
          const from = Math.max(0, at - 40);
          snippet = (from > 0 ? "…" : "") + text.slice(from, at + q.length + 60).replace(/\s+/g, " ") + "…";
        }
      }
      if (hits) out.push({ id, title, model, createdAt, snippet, hits });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out.slice(0, limit);
}

/** Cheap deterministic digest used for compaction (no extra API call). */
export function summarize(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages.slice(0, 60)) {
    const text = textOf(m.content);
    const head = text.split("\n").slice(0, 2).join(" ").slice(0, 160);
    const img = text.includes("[image]") ? " [image]" : "";
    const tools = m.toolCalls?.map((tc: ToolCall) => `${tc.name}(${String(tc.arguments.path ?? tc.arguments.command ?? "").slice(0, 60)})`).join(", ");
    parts.push(`${m.role}: ${head}${img}${tools ? ` [called: ${tools}]` : ""}`);
  }
  return `[Summary of ${messages.length} earlier messages]\n${parts.join("\n")}`;
}
