/**
 * JSONL session persistence: ~/.goatcode/sessions/<id>.jsonl
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./config.ts";
import type { Message, ToolCall } from "./llm.ts";
import { textOf } from "./llm.ts";

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
  }

  static new(cwd: string, model: string): Session {
    return new Session({ id: newId(), cwd, model });
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

  save(): void {
    const lines = [
      JSON.stringify({
        meta: true, id: this.id, cwd: this.cwd, model: this.model,
        title: this.title, createdAt: this.createdAt,
        compactedFrom: this.compactedFrom, usage: this.usage, digest: this.digest,
        turnMarks: this.turnMarks,
      }),
      ...this.messages.map((m) => JSON.stringify(m)),
    ];
    writeFileSync(this.path(), lines.join("\n") + "\n", "utf8");
  }

  load(): void {
    if (!existsSync(this.path())) throw new Error(`no session ${this.id}`);
    const lines = readFileSync(this.path(), "utf8").split("\n").filter(Boolean);
    const msgs: Message[] = [];
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.meta) {
        this.cwd = obj.cwd; this.model = obj.model; this.title = obj.title ?? "";
        this.createdAt = obj.createdAt; this.compactedFrom = obj.compactedFrom ?? 0;
        this.usage = { cacheRead: 0, cacheWrite: 0, ...(obj.usage ?? {}) };
        this.digest = obj.digest ?? "";
        this.turnMarks = Array.isArray(obj.turnMarks) ? obj.turnMarks : [];
      } else {
        msgs.push(obj as Message);
      }
    }
    this.messages = msgs;
  }

  /** The window sent to the provider: everything after the compaction cut. */
  context(): Message[] {
    return this.messages.slice(this.compactedFrom);
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
