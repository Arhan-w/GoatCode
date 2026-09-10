/**
 * Agent tools: read, write, edit, bash, undo, tasks, glob, grep, webfetch,
 * websearch, screenshot, computer — sandboxed to project root, with a
 * permission callback for mutating ops. Write/edit snapshot the file first
 * so /undo can revert; bash supports background:true for long-running jobs;
 * screenshot/computer drive the real desktop (see computer.ts). External
 * tools (MCP servers) register through the same dispatch table.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { decide } from "./permissions.ts";
import { fireHooks, type HooksConfig } from "./hooks.ts";
import { log } from "./logger.ts";
import { MAX_WEBFETCH_BYTES, WEBFETCH_TIMEOUT_MS } from "./constants.ts";
import { desktop, type DesktopBackend } from "./computer.ts";
import type { ContentPart, ToolSpec } from "./llm.ts";

/** SSRF guard: refuse loopback / private / link-local / cloud-metadata hosts.
 *  Pattern-based (literal IPs + reserved suffixes); hostnames that resolve to
 *  private addresses are not caught — same tradeoff as most CLI fetch tools. */
export async function isPrivateHost(host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (/^0+$/.test(h.replace(/\./g, ""))) return true;
  if (/^(fe80|fc|fd|::1)/i.test(h)) return true; // link-local / ULA / IPv6 loopback
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

export const MAX_READ_BYTES = 128_000;
export const MAX_BASH_OUTPUT = 32_000;
export const BASH_TIMEOUT = 120;
export const GREP_MAX_RESULTS = 200;
export const GLOB_MAX_RESULTS = 300;
export const MAX_UNDO = 50;
export const MAX_SNAP_BYTES = 512_000;
export const MAX_IMAGE_BYTES = 5_000_000;
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

/** Strip HTML tags + entities (search result text). */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

/**
 * Detect real image type from magic bytes — never trust the extension.
 * Returns a media type, or null if the buffer isn't a supported image.
 */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const sig = buf.subarray(0, 6).toString("latin1");
  if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
export const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "dist",
  "build", ".next", ".cache", "target", ".tox", ".mypy_cache", ".goat",
]);

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Multimodal payload (e.g. read on an image) — carried into the tool message. */
  content?: ContentPart[];
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

/** Agent-maintained plan step (Claude Code TodoWrite analogue, same schema). */
export interface Todo {
  /** Imperative form: "Run tests". */
  content: string;
  /** Present continuous shown while running: "Running tests". */
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
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
  /** settings.json-style allow/deny rules, consulted before the prompt. */
  rules: { allow: string[]; deny: string[] } | undefined;
  /** Claude-compatible hooks (set from config per turn; undefined = off). */
  hooks: HooksConfig | undefined;
  sessionId = "goat";
  private hookAllowNext = false;
  external = new Map<string, ExternalTool>();

  private snaps: SnapRecord[] = [];
  private bg = new Map<string, BgTask>();
  private todos: Todo[] = [];

  constructor(root: string, opts: { permission?: PermissionFn; autoApprove?: boolean; readonly?: boolean; rules?: { allow: string[]; deny: string[] } } = {}) {
    this.root = resolve(root);
    this.permission = opts.permission ?? null;
    this.autoApprove = opts.autoApprove ?? false;
    this.readonly = opts.readonly ?? false;
    this.rules = opts.rules;
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
      // Claude wire-compat: file tools report their arg as file_path
      const hookArgs = { ...args };
      if ((name === "read" || name === "write" || name === "edit") && args.path !== undefined)
        hookArgs.file_path = args.path;
      const hookPayload = () => ({
        session_id: this.sessionId, transcript_path: "", cwd: this.root,
        hook_event_name: "PreToolUse" as const, hookEventName: "PreToolUse" as const,
        tool_name: name, tool_input: hookArgs,
      });
      // PreToolUse hooks: exit-2 blocks; permissionDecision can skip the prompt
      this.hookAllowNext = false;
      if (this.hooks?.PreToolUse?.length) {
        const hr = await fireHooks(this.hooks, "PreToolUse", hookPayload(), this.sessionId);
        if (hr.blocked) return { ok: false, output: `blocked by PreToolUse hook: ${hr.reason ?? "(no reason)"}` };
        if (hr.decision === "deny") return { ok: false, output: `denied by PreToolUse hook: ${hr.reason ?? ""}` };
        if (hr.decision === "allow") this.hookAllowNext = true;
        if (hr.updatedInput) { args = hr.updatedInput; } // hook rewrote the tool input
      }
      let result: ToolResult;
      if (ext) {
        if (ext.mutating && !this.hookAllowNext) {
          const denied = await this.ask(name, args);
          if (denied) return denied;
        }
        result = await ext.run(args, signal);
      } else {
        const handler = (this as any)[`tool_${name}`];
        if (!handler) result = { ok: false, output: `unknown tool: ${name}` };
        else result = await handler.call(this, args, signal);
      }
      // PostToolUse hooks (informational + exit-2 blocking of a completed call's use)
      if (this.hooks?.PostToolUse?.length) {
        const hr = await fireHooks(this.hooks, "PostToolUse", {
          ...hookPayload(), hook_event_name: "PostToolUse",
          tool_response: { stdout: result.output.slice(0, 30_000), stderr: "", interrupted: false },
        }, this.sessionId);
        if (hr.blocked) result = { ok: false, output: `PostToolUse hook flagged output: ${hr.reason ?? "(exit 2)"}` };
      }
      return result;
    } catch (e: any) {
      return { ok: false, output: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
    }
  }

  private async ask(tool: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    // plan mode: mutating tools never run — explain how to leave the mode
    if (this.readonly)
      return { ok: false, output: `${tool} blocked by plan mode (read-only). Shift+tab to switch to default/accept-edits mode, or present the plan and let the user approve it.` };
    // settings-style rules: deny beats allow beats asking
    const verdict = decide(this.rules, tool, args);
    if (verdict === "deny") return { ok: false, output: `${tool} denied by permission rule (see "permissions.deny" in config)` };
    if (verdict === "allow" || this.hookAllowNext) return null;
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
    const ext = p.toLowerCase().slice(p.lastIndexOf("."));
    if (IMAGE_TYPES[ext]) {
      // vision input: sniff magic bytes — the extension is only a hint
      const size = statSync(p).size;
      if (size > MAX_IMAGE_BYTES)
        return { ok: false, output: `image too large (${size} bytes; max ${MAX_IMAGE_BYTES})` };
      const buf = readFileSync(p);
      const mediaType = sniffImage(buf);
      if (!mediaType)
        return { ok: false, output: `${args.path} has an image extension but isn't a png/jpeg/gif/webp file` };
      return {
        ok: true,
        output: `read image ${args.path} (${mediaType}, ${size} bytes)`,
        content: [{ type: "text", text: `[image ${args.path}]` }, { type: "image", data: buf.toString("base64"), mediaType }],
      };
    }
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

  async tool_webfetch(args: Record<string, any>): Promise<ToolResult> {
    const raw = String(args.url ?? "");
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, output: `invalid url: ${raw}` }; }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { ok: false, output: `only http(s) allowed, got ${url.protocol}` };
    // SSRF guard: block private/localhost targets (skip permission prompt for them)
    const host = url.hostname.toLowerCase();
    if (await isPrivateHost(host))
      return { ok: false, output: `refused private/loopback address: ${host}` };
    const denied = await this.ask("webfetch", args); // WebFetch(domain:x) rules apply
    if (denied) return denied;
    try {
      const res = await fetch(url.toString(), {
        redirect: "follow", signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS),
        headers: { "user-agent": "goatcode/2.0 (+https://github.com/Arhan-w/GoatCode)" },
      });
      if (!res.ok) return { ok: false, output: `HTTP ${res.status} ${res.statusText}` };
      const ct = res.headers.get("content-type") ?? "";
      if (!/text|json|xml|markdown|html/.test(ct))
        return { ok: false, output: `unsupported content-type: ${ct}` };
      let text = await res.text();
      if (ct.includes("html")) {
        text = text
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;|&#38;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
          .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      }
      const clipped = text.slice(0, MAX_WEBFETCH_BYTES);
      const more = text.length > clipped.length ? `\n... [truncated from ${text.length} bytes]` : "";
      const ask = args.prompt ? `\n\n[Look for: ${String(args.prompt).slice(0, 300)}]` : "";
      return { ok: true, output: `# ${url.hostname} — ${ct.split(";")[0]}\n${clipped}${more}${ask}` };
    } catch (e: any) {
      return { ok: false, output: `fetch failed: ${e?.message ?? e}` };
    }
  }

  /** Keyless web search via DuckDuckGo's HTML endpoint (also lite fallback). */
  async tool_websearch(args: Record<string, any>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, output: "websearch requires a query" };
    const denied = await this.ask("websearch", args);
    if (denied) return denied;
    const max = Math.min(15, Math.max(1, Number(args.max_results ?? 8)));
    try {
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) goatcode/2.0",
        },
        body: new URLSearchParams({ q: query, kl: "wt-wat" } as any).toString(),
        redirect: "follow",
        signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, output: `search failed: HTTP ${res.status}` };
      const html = await res.text();
      // result anchors: <a rel="nofollow" class="result__a" href="...">Title</a>
      // + snippet: <a class="result__snippet">...</a>
      const results: { title: string; url: string; snippet: string }[] = [];
      const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const snippets: string[] = [];
      for (const s of html.matchAll(snipRe)) snippets.push(stripTags(s[1]).trim());
      let k = 0;
      for (const m of html.matchAll(linkRe)) {
        if (results.length >= max) break;
        let url = m[1];
        // ddg wraps links: //duckduckgo.com/l/?uddg=<encoded>&rut=...
        const um = url.match(/[?&]uddg=([^&]+)/);
        if (um) { try { url = decodeURIComponent(um[1]); } catch { /* keep raw */ } }
        results.push({ title: stripTags(m[2]).trim(), url, snippet: snippets[k++] ?? "" });
      }
      if (!results.length) return { ok: false, output: `no results for "${query}" (search endpoint may be rate-limited — try webfetch on a known URL)` };
      const lines = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 240)}` : ""}`);
      return { ok: true, output: `# results for: ${query}\n${lines.join("\n")}\n\n[Use webfetch to read a result in full.]` };
    } catch (e: any) {
      return { ok: false, output: `search failed: ${e?.message ?? e}` };
    }
  }

  // ---- desktop control ----------------------------------------------------

  /** Capture the real screen; attach the PNG so vision models can see it. */
  async tool_screenshot(args: Record<string, any>): Promise<ToolResult> {
    const denied = await this.ask("computer", { action: "screenshot" });
    if (denied) return denied;
    try {
      const out = join(this.root, ".goat", `screen-${Date.now()}.png`);
      mkdirSync(dirname(out), { recursive: true });
      const shot = await desktop.screenshot(out);
      const rel = relative(this.root, out).replaceAll("\\", "/");
      const dims = shot.width ? ` ${shot.width}x${shot.height}px` : "";
      if (args.path) { // save a copy somewhere the user asked for
        try { writeFileSync(this.inside(String(args.path)), shot.png); } catch { /* non-sandbox save */ }
      }
      return {
        ok: true,
        output: `screen captured (${dims}, ${shot.png.length} bytes) → ${rel}`,
        content: [
          { type: "text", text: `[screenshot${dims} — saved to ${rel}; click coordinates are screen pixels]` },
          { type: "image", data: shot.png.toString("base64"), mediaType: "image/png" },
        ],
      };
    } catch (e: any) {
      return { ok: false, output: `screenshot failed: ${e?.message ?? e} (backend: ${await desktop.detect()})` };
    }
  }

  /** One tool for every desktop action: click / type / key / scroll / launch / windows / clipboard. */
  async tool_computer(args: Record<string, any>): Promise<ToolResult> {
    const action = String(args.action ?? "");
    if (!action) return { ok: false, output: "computer requires an action" };
    const denied = await this.ask("computer", args);
    if (denied) return denied;
    try {
      const msg = await desktop.act(action, args);
      const backend = desktop.backend as DesktopBackend;
      return { ok: true, output: `[${backend}] ${msg}` };
    } catch (e: any) {
      return { ok: false, output: `computer ${action} failed: ${e?.message ?? e}` };
    }
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

  /** Current plan (for UI rendering). */
  plan(): Todo[] {
    return this.todos.map((t) => ({ ...t }));
  }

  tool_todo(args: Record<string, any>): ToolResult {
    const raw = Array.isArray(args.todos) ? args.todos : [];
    const todos: Todo[] = [];
    for (const t of raw.slice(0, 64)) {
      if (!t || typeof t !== "object") continue;
      const content = String(t.content ?? "").slice(0, 500);
      if (!content) continue;
      const activeForm = String(t.activeForm ?? t.active_form ?? content).slice(0, 500);
      const s = t.status === "completed" || t.status === "in_progress" ? t.status : "pending";
      todos.push({ content, activeForm, status: s });
    }
    if (!todos.length) return { ok: false, output: "todos must be a non-empty array of {content, activeForm, status}" };
    this.todos = todos;
    const done = todos.filter((t) => t.status === "completed").length;
    return { ok: true, output: `plan updated: ${done}/${todos.length} completed` };
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
      ...otherSpecs,
      {
        name: "check-update",
        description: "Check for new GoatCode updates",
        parameters: {},
        required: []
      }
    ];
  return [
    { name: "read", description: "Read a file from the project. Text files return numbered lines; images (png/jpg/gif/webp) are shown to the model visually.",
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
    { name: "task", description:
      "Launch a focused sub-agent with a fresh context that shares your tools. It has ZERO knowledge of this conversation — brief it completely. Use for research/exploration (subagent_type 'explore' = read-only) or self-contained multi-step work. It returns one final report; you must summarize it for the user.",
      parameters: { type: "object", properties: {
        description: { type: "string", description: "3-5 word label" },
        prompt: { type: "string", description: "Full task brief for the sub-agent" },
        subagent_type: { type: "string", enum: ["explore", "general"], description: "explore = read-only research; general = full tools" },
      }, required: ["description", "prompt"] } },
    { name: "webfetch", description: "Fetch a URL and return readable text. Blocked for private/localhost addresses.",
      parameters: { type: "object", properties: {
        url: { type: "string", description: "http(s) URL" },
        prompt: { type: "string", description: "What to look for (returned alongside the text; text is truncated to 200 KB)" },
      }, required: ["url"] } },
    { name: "screenshot", description:
      "Capture the real desktop screen and SEE it (the image is attached to your next turn on vision models). Coordinates for the computer tool are screen pixels from this image. Optional path saves a copy into the project.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Optional project-relative path to save the PNG" },
      } } },
    { name: "websearch", description:
      "Search the web (DuckDuckGo) and get titles, URLs, snippets. No API key needed. Use for current events, library docs, error messages. Then webfetch the best result for details.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", description: "1-15 results (default 8)" },
      }, required: ["query"] } },
    { name: "computer", description:
      "Control the user's desktop like a person: click, type, press keys, scroll, launch apps, list windows, read/write the clipboard. Workflow: screenshot first to see the screen -> act with coordinates from that image -> screenshot again to verify. Background-first when a driver is installed (no focus steal). NEVER click permission/payment/password dialogs or type secrets; stop and ask the user instead.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["click", "double_click", "right_click", "type", "key", "scroll", "launch", "windows", "clipboard"],
          description: "What to do" },
        x: { type: "integer", description: "Screen x pixel (click/scroll) from the last screenshot" },
        y: { type: "integer", description: "Screen y pixel" },
        text: { type: "string", description: "Text to type, or clipboard content to set" },
        combo: { type: "string", description: "key action: e.g. 'ctrl+s', 'alt+tab', 'enter'" },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "scroll direction" },
        amount: { type: "integer", description: "scroll ticks (default 3)" },
        app: { type: "string", description: "launch: app name or full path" },
        pid: { type: "integer", description: "Target process id (from the windows action) — required for type on Windows via driver; clicks route to the window under the point" },
        window_title: { type: "string", description: "Alternative to pid: case-insensitive substring of the window title to target (type/key)" },
      }, required: ["action"] } },
    { name: "todo", description:
      "Create and manage a structured task list for the current work. Use proactively for multi-step tasks (3+ steps); update statuses in real time — mark a task in_progress BEFORE starting it and completed IMMEDIATELY after, exactly one in_progress at a time. Skip it for single trivial tasks. Do not batch completions. The list is shown live to the user.",
      parameters: { type: "object", properties: {
        todos: { type: "array", description: "The FULL replacement list (send the whole plan every time)", items: {
          type: "object", properties: {
            content: { type: "string", description: "Imperative form, e.g. 'Run tests'" },
            activeForm: { type: "string", description: "Present continuous shown while running, e.g. 'Running tests'" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          }, required: ["content", "activeForm", "status"] },
        },
      }, required: ["todos"] } },
  ];
}
