/**
 * Agent tools: read, write, edit, bash, undo, tasks, glob, grep — sandboxed
 * to project root, with a permission callback for mutating ops. Write/edit
 * snapshot the file first so /undo can revert; bash supports background:true
 * for long-running jobs. External tools (MCP servers) register through the
 * same dispatch table.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ToolSpec } from "./llm.ts";

export const MAX_READ_BYTES = 128_000;
export const MAX_BASH_OUTPUT = 32_000;
export const BASH_TIMEOUT = 120;
export const GREP_MAX_RESULTS = 200;
export const GLOB_MAX_RESULTS = 300;
export const MAX_UNDO = 50;
export const MAX_SNAP_BYTES = 512_000;
export const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "dist",
  "build", ".next", ".cache", "target", ".tox", ".mypy_cache",
]);

export interface ToolResult {
  ok: boolean;
  output: string;
}

export type PermissionFn = (tool: string, args: Record<string, unknown>) => Promise<boolean> | boolean;

export interface ExternalTool {
  spec: ToolSpec;
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
  /** true = needs the permission prompt like write/edit/bash */
  mutating?: boolean;
}

/** One captured file mutation. path is ABSOLUTE; existed=false means the
 *  mutation created the file, so undo deletes it instead of restoring. */
export type SnapRecord = { path: string; existed: boolean; before: string; after: string };

/** glob (**, *, ?) -> anchored regex */
export function fnmatch(rel: string, pattern: string): boolean {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { rx += ".*"; i++; if (pattern[i + 1] === "/") i++; }
      else rx += "[^/]*";
    } else if (c === "?") rx += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) rx += "\\" + c;
    else rx += c;
  }
  return new RegExp("^" + rx + "$").test(rel);
}

function walk(root: string, onFile: (abs: string, rel: string) => boolean | void): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(root, e.name), onFile);
    } else if (e.isFile()) {
      const abs = join(root, e.name);
      if (onFile(abs, relative(root, abs).replaceAll("\\", "/")) === false) return;
    }
  }
}

export interface BgTask {
  id: string;
  cmd: string;
  status: string;
  started: number;
}

export class ToolKit {
  root: string;
  permission: PermissionFn | null;
  autoApprove: boolean;
  readonly = false;
  external = new Map<string, ExternalTool>();

  private snaps: SnapRecord[] = [];
  private bg = new Map<string, BgTask>();

  constructor(root: string, opts: { permission?: PermissionFn; autoApprove?: boolean; readonly?: boolean } = {}) {
    this.root = resolve(root);
    this.permission = opts.permission ?? null;
    this.autoApprove = opts.autoApprove ?? false;
    this.readonly = opts.readonly ?? false;
  }

  /** Membership, not string-prefix: "/root" prefixes "/rootkit" but isn't its parent. */
  inside(path: string): string {
    const p = resolve(this.root, path);
    if (p !== this.root) {
      const rel = relative(this.root, p);
      if (rel === "" || rel.startsWith(".."))
        throw new Error(`path escapes project root: ${path}`);
    }
    return p;
  }

  registerExternal(tool: ExternalTool): void {
    this.external.set(tool.spec.name, tool);
  }

  unregisterExternal(prefix: string): void {
    for (const name of [...this.external.keys()])
      if (name.startsWith(prefix)) this.external.delete(name);
  }

  specs(): ToolSpec[] {
    return [...builtinSpecs(), ...[...this.external.values()].map((t) => t.spec)];
  }

  async dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    try {
      const ext = this.external.get(name);
      if (ext) {
        if (ext.mutating) {
          const denied = await this.ask(name, args);
          if (denied) return denied;
        }
        return await ext.run(args, signal);
      }
      const handler = (this as any)[`tool_${name}`];
      if (!handler) return { ok: false, output: `unknown tool: ${name}` };
      return await handler.call(this, args, signal);
    } catch (e: any) {
      return { ok: false, output: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
    }
  }

  private async ask(tool: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    // plan mode: mutating tools never run — explain how to leave the mode
    if (this.readonly)
      return { ok: false, output: `${tool} blocked by plan mode (read-only). Shift+tab to switch to default/accept-edits mode, or present the plan and let the user approve it.` };
    if (this.autoApprove) return null;
    if (!this.permission)
      return { ok: false, output: `permission required but no prompt available for ${tool}` };
    const approved = await this.permission(tool, args);
    if (!approved)
      return { ok: false, output: `user denied ${tool} for ${String(args.path ?? args.command ?? "")}` };
    return null;
  }

  // ---- undo / snapshots ---------------------------------------------------

  private checkpoints: number[] = []; // snaps.length at each turn boundary

  /** Mark the start of a turn; undoCheckpoint() later reverts everything after it. */
  beginCheckpoint(): void {
    this.checkpoints.push(this.snaps.length);
  }

  private snap(absPath: string, existed: boolean, before: string, after: string): void {
    if (before.length > MAX_SNAP_BYTES || after.length > MAX_SNAP_BYTES) return; // too big to snapshot
    this.snaps.push({ path: absPath, existed, before, after });
    if (this.snaps.length > MAX_UNDO) {
      this.snaps.shift();
      // keep turn boundaries aligned with the evicted index
      this.checkpoints = this.checkpoints.map((c) => Math.max(0, c - 1));
    }
  }

  /** Revert the most recent snapshot. Returns the record (path is absolute). */
  undo(): SnapRecord | null {
    const rec = this.snaps.pop() ?? null;
    if (!rec) return null;
    this.restore(rec);
    return rec;
  }

  /** Revert every snapshot taken since the last beginCheckpoint(). Returns count. */
  undoCheckpoint(): number {
    const boundary = this.checkpoints.pop();
    if (boundary === undefined) return this.snaps.length ? this.undoAll().length : 0;
    let n = 0;
    while (this.snaps.length > boundary) { this.undo(); n++; }
    return n;
  }

  undoAll(): SnapRecord[] {
    const out: SnapRecord[] = [];
    while (this.snaps.length) out.push(this.undo()!);
    return out;
  }

  private restore(rec: SnapRecord): void {
    try {
      if (rec.existed) writeFileSync(rec.path, rec.before, "utf8");
      else if (existsSync(rec.path)) unlinkSync(rec.path);
    } catch { /* best-effort */ }
  }

  // ---- background bash ----------------------------------------------------

  private nextId(): string {
    return `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  private startBg(cmd: string, timeout: number): BgTask {
    const id = this.nextId();
    const task: BgTask = { id, cmd, status: "running", started: Date.now() };
    this.bg.set(id, task);
    const shell = process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : "/bin/bash";
    const child = spawn(shell, process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], {
      cwd: this.root, env: process.env,
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); }, timeout);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = out + (err ? `\n[stderr]\n${err}` : "");
      const tail = code === 0 ? "" : `\n[exit code ${code}]`;
      this.bg.set(id, { ...task, status: `${(combined.trim() || "(no output)").slice(0, MAX_BASH_OUTPUT)}${tail}`, started: task.started });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      this.bg.set(id, { ...task, status: `spawn failed: ${e.message}`, started: task.started });
    });
    return task;
  }

  backgroundTasks(): BgTask[] {
    return [...this.bg.values()];
  }

  // ---- implementations --------------------------------------------------

  tool_read(args: Record<string, any>): ToolResult {
    const p = this.inside(String(args.path));
    if (!existsSync(p) || !statSync(p).isFile()) return { ok: false, output: `not a file: ${args.path}` };
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch { return { ok: false, output: `${args.path} is not UTF-8 text` }; }
    const lines = text.split("\n");
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.max(1, Number(args.limit ?? 2000));
    const chunk = lines.slice(offset - 1, offset - 1 + limit);
    let out = chunk.map((ln, i) => `${String(offset + i).padStart(5)}\t${ln}`).join("\n");
    const remaining = Math.max(0, lines.length - (offset - 1) - chunk.length);
    if (remaining || text.length > MAX_READ_BYTES) out += `\n... [${remaining} more lines]`;
    return { ok: true, output: out || "(empty file)" };
  }

  async tool_write(args: Record<string, any>): Promise<ToolResult> {
    const denied = await this.ask("write", args);
    if (denied) return denied;
    const p = this.inside(String(args.path));
    mkdirSync(dirname(p), { recursive: true });
    const existed = existsSync(p);
    const before = existed ? readFileSync(p, "utf8") : "";
    writeFileSync(p, String(args.content ?? ""), "utf8");
    this.snap(p, existed, before, String(args.content ?? ""));
    const n = String(args.content ?? "").split("\n").length;
    return { ok: true, output: `${existed ? "updated" : "created"} ${args.path} (${n} lines)` };
  }

  async tool_edit(args: Record<string, any>): Promise<ToolResult> {
    const denied = await this.ask("edit", args);
    if (denied) return denied;
    const p = this.inside(String(args.path));
    if (!existsSync(p)) return { ok: false, output: `not a file: ${args.path}` };
    const text = readFileSync(p, "utf8");
    const old = String(args.old_string ?? ""), neu = String(args.new_string ?? "");
    const count = text.split(old).length - 1;
    if (count === 0) return { ok: false, output: "old_string not found in file" };
    if (count > 1) return { ok: false, output: `old_string matches ${count} times; make it unique` };
    const after = text.replace(old, neu);
    writeFileSync(p, after, "utf8");
    this.snap(p, true, text, after);
    return { ok: true, output: `edited ${args.path}` };
  }

  tool_bash(args: Record<string, any>): Promise<ToolResult> {
    return new Promise(async (done) => {
      const denied = await this.ask("bash", args);
      if (denied) return done(denied);
      const cmd = String(args.command ?? "");
      const timeout = Math.min(Number(args.timeout ?? BASH_TIMEOUT), 600) * 1000;
      if (args.background === true) {
        const task = this.startBg(cmd, timeout);
        return done({ ok: true, output: `started background task ${task.id} (${cmd}) — check with the tasks tool or ctrl+t` });
      }
      const shell = process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : "/bin/bash";
      const child = spawn(shell, process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], {
        cwd: this.root, env: process.env,
      });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill(); done({ ok: false, output: `command timed out after ${timeout / 1000}s` }); }, timeout);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => {
        clearTimeout(timer);
        const combined = out + (err ? `\n[stderr]\n${err}` : "");
        const capped = combined.slice(0, MAX_BASH_OUTPUT);
        const tail = code === 0 ? "" : `\n[exit code ${code}]`;
        done({ ok: code === 0, output: (capped.trim() || "(no output)") + tail });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        done({ ok: false, output: `spawn failed: ${e.message}` });
      });
    });
  }

  tool_undo(): ToolResult {
    if (this.readonly)
      return { ok: false, output: "undo blocked by plan mode — the user can still run /undo from the prompt" };
    const rec = this.undo();
    if (!rec) return { ok: false, output: "nothing to undo" };
    const shown = relative(this.root, rec.path).replaceAll("\\", "/") || rec.path;
    return { ok: true, output: `reverted ${shown}${rec.existed ? "" : " (deleted — file was created this session)"}` };
  }

  tool_tasks(): ToolResult {
    const rows = this.backgroundTasks();
    if (!rows.length) return { ok: true, output: "(no background tasks)" };
    return {
      ok: true,
      output: rows.map((r) =>
        `${r.id}\t${new Date(r.started).toISOString().slice(11, 19)}\t${r.cmd.slice(0, 60)}\t=> ${r.status.slice(0, 400)}`,
      ).join("\n"),
    };
  }

  tool_glob(args: Record<string, any>): ToolResult {
    const pattern = String(args.pattern ?? "");
    const matches: string[] = [];
    const base = this.root;
    const walkAbs = (dir: string) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (matches.length >= GLOB_MAX_RESULTS) return;
        const abs = join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkAbs(abs); }
        else {
          const rel = relative(base, abs).replaceAll("\\", "/");
          if (fnmatch(rel, pattern) || fnmatch(e.name, pattern)) matches.push(rel);
        }
      }
    };
    walkAbs(base);
    return { ok: true, output: matches.sort().join("\n") + (matches.length >= GLOB_MAX_RESULTS ? "\n... (truncated)" : "") || "(no matches)" };
  }

  tool_grep(args: Record<string, any>): ToolResult {
    let rx: RegExp;
    try { rx = new RegExp(String(args.pattern)); }
    catch (e: any) { return { ok: false, output: `invalid regex: ${e.message}` }; }
    const base = this.inside(String(args.path ?? "."));
    const glob = args.glob ? String(args.glob) : null;
    const results: string[] = [];
    const scan = (dir: string) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= GREP_MAX_RESULTS) return;
        const abs = join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) scan(abs); }
        else {
          if (glob && !fnmatch(e.name, glob)) continue;
          let text: string;
          try {
            if (statSync(abs).size > 2_000_000) continue;
            text = readFileSync(abs, "utf8");
            if (text.includes("\0")) continue; // binary
          } catch { continue; }
          text.split("\n").forEach((line, i) => {
            if (results.length >= GREP_MAX_RESULTS) return;
            if (rx.test(line)) {
              const rel = relative(this.root, abs).replaceAll("\\", "/");
              results.push(`${rel}:${i + 1}:${line.slice(0, 200)}`);
            }
          });
        }
      }
    };
    scan(base);
    return { ok: true, output: results.join("\n") + (results.length >= GREP_MAX_RESULTS ? "\n... (truncated)" : "") || "(no matches)" };
  }
}

function builtinSpecs(): ToolSpec[] {
  return [
    { name: "read", description: "Read a file from the project. Returns text with line numbers.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "File path relative to project root" },
        offset: { type: "integer", description: "1-based start line (optional)" },
        limit: { type: "integer", description: "Max lines to read (optional)" },
      }, required: ["path"] } },
    { name: "write", description: "Create or overwrite a file with exact content. The change can be reverted with undo.",
      parameters: { type: "object", properties: {
        path: { type: "string" },
        content: { type: "string", description: "Full file content" },
      }, required: ["path", "content"] } },
    { name: "edit", description: "Replace one exact string in a file (must match once). The change can be reverted with undo.",
      parameters: { type: "object", properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace, unique in file" },
        new_string: { type: "string" },
      }, required: ["path", "old_string", "new_string"] } },
    { name: "bash", description: "Run a shell command in the project directory. Set background=true for long jobs; poll results with the tasks tool.",
      parameters: { type: "object", properties: {
        command: { type: "string" },
        timeout: { type: "integer", description: `Seconds, default ${BASH_TIMEOUT}` },
        background: { type: "boolean", description: "Run detached, return a task id immediately" },
      }, required: ["command"] } },
    { name: "undo", description: "Revert the most recent write/edit made in this session.",
      parameters: { type: "object", properties: {} } },
    { name: "tasks", description: "List background bash tasks and their status.",
      parameters: { type: "object", properties: {} } },
    { name: "glob", description: "Find files by pattern, e.g. 'src/**/*.ts'.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
    { name: "grep", description: "Search file contents by regex. Returns path:line:text.",
      parameters: { type: "object", properties: {
        pattern: { type: "string", description: "Regex" },
        path: { type: "string", description: "Subdirectory to search (default .)" },
        glob: { type: "string", description: "Filename filter, e.g. '*.py'" },
      }, required: ["pattern"] } },
  ];
}
