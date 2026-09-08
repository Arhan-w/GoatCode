/**
 * Agent tools: read, write, edit, bash, glob, grep — sandboxed to project
 * root, with a permission callback for mutating ops. External tools (MCP
 * servers, skills) register through the same dispatch table.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ToolSpec } from "./llm.ts";

export const MAX_READ_BYTES = 128_000;
export const MAX_BASH_OUTPUT = 32_000;
export const BASH_TIMEOUT = 120;
export const GREP_MAX_RESULTS = 200;
export const GLOB_MAX_RESULTS = 300;
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

export class ToolKit {
  root: string;
  permission: PermissionFn | null;
  autoApprove: boolean;
  external = new Map<string, ExternalTool>();

  constructor(root: string, opts: { permission?: PermissionFn; autoApprove?: boolean } = {}) {
    this.root = resolve(root);
    this.permission = opts.permission ?? null;
    this.autoApprove = opts.autoApprove ?? false;
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
      return await handler.call(this, args);
    } catch (e: any) {
      return { ok: false, output: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
    }
  }

  private async ask(tool: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    if (this.autoApprove) return null;
    if (!this.permission)
      return { ok: false, output: `permission required but no prompt available for ${tool}` };
    const approved = await this.permission(tool, args);
    if (!approved)
      return { ok: false, output: `user denied ${tool} for ${String(args.path ?? args.command ?? "")}` };
    return null;
  }

  // ---- implementations --------------------------------------------------

  tool_read(args: Record<string, any>): ToolResult {
    const p = this.inside(String(args.path));
    if (!existsSync(p) || !statSync(p).isFile()) return { ok: false, output: `not a file: ${args.path}` };
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch { return { ok: false, output: `${args.path} is not UTF-8 text` }; }
    const lines = text.split("\n");
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Number(args.limit ?? 2000);
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
    writeFileSync(p, String(args.content ?? ""), "utf8");
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
    writeFileSync(p, text.replace(old, neu), "utf8");
    return { ok: true, output: `edited ${args.path}` };
  }

  tool_bash(args: Record<string, any>): Promise<ToolResult> {
    return new Promise(async (done) => {
      const denied = await this.ask("bash", args);
      if (denied) return done(denied);
      const cmd = String(args.command ?? "");
      const timeout = Math.min(Number(args.timeout ?? BASH_TIMEOUT), 600) * 1000;
      const shell = process.platform === "win32"
        ? (process.env.COMSPEC || "cmd.exe")
        : "/bin/bash";
      const child = spawn(shell, process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], {
        cwd: this.root, env: process.env,
      });
      let out = "";
      let err = "";
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
    { name: "write", description: "Create or overwrite a file with exact content.",
      parameters: { type: "object", properties: {
        path: { type: "string" },
        content: { type: "string", description: "Full file content" },
      }, required: ["path", "content"] } },
    { name: "edit", description: "Replace one exact string in a file (must match once).",
      parameters: { type: "object", properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace, unique in file" },
        new_string: { type: "string" },
      }, required: ["path", "old_string", "new_string"] } },
    { name: "bash", description: "Run a shell command in the project directory.",
      parameters: { type: "object", properties: {
        command: { type: "string" },
        timeout: { type: "integer", description: `Seconds, default ${BASH_TIMEOUT}` },
      }, required: ["command"] } },
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
