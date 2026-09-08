/**
 * JSONL session persistence: ~/.goatcode/sessions/<id>.jsonl
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./config.ts";
import type { Message, ToolCall } from "./llm.ts";

export interface SessionData {
  id: string;
  cwd: string;
  model: string;
  title: string;
  createdAt: number;
  usage: { in: number; out: number };
  messages: Message[];
  compactedFrom: number;
}

function sessionsDir(): string {
  const d = join(appDir(), "sessions");
  mkdirSync(d, { recursive: true });
  return d;
}

function newId(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
}

export class Session {
  id: string;
  cwd: string;
  model: string;
  title = "";
  createdAt: number;
  messages: Message[] = [];
  compactedFrom = 0;
  usage = { in: 0, out: 0 };

  constructor(init: Partial<SessionData> & { id: string; cwd: string; model: string }) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.title = init.title ?? "";
    this.createdAt = init.createdAt ?? Date.now() / 1000;
    this.messages = init.messages ?? [];
    this.compactedFrom = init.compactedFrom ?? 0;
    this.usage = init.usage ?? { in: 0, out: 0 };
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
        compactedFrom: this.compactedFrom, usage: this.usage,
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
        this.usage = obj.usage ?? { in: 0, out: 0 };
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

/** Cheap deterministic digest used for compaction (no extra API call). */
export function summarize(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages.slice(0, 60)) {
    const head = m.content.split("\n").slice(0, 2).join(" ").slice(0, 160);
    const tools = m.toolCalls?.map((tc: ToolCall) => `${tc.name}(${String(tc.arguments.path ?? tc.arguments.command ?? "").slice(0, 60)})`).join(", ");
    parts.push(`${m.role}: ${head}${tools ? ` [called: ${tools}]` : ""}`);
  }
  return `[Summary of ${messages.length} earlier messages]\n${parts.join("\n")}`;
}
