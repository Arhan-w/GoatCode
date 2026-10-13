/**
 * goat ide — the GoatCode IDE: a Monaco-based web IDE served locally with the
 * full GoatCode agent embedded.
 *
 * Same trust model as `goat web`: binds 127.0.0.1 only, requires a per-boot
 * token in the URL, and streams the live agent loop over SSE. The editor is
 * the vendored Monaco engine (MIT, from VS Code) — no network needed.
 *
 * Endpoints:
 *   GET  /                    the IDE shell (HTML)
 *   GET  /vendor/vs/*         vendored Monaco assets
 *   GET  /api/events?token=   SSE: hello/state/user/agent/permission/file
 *   POST /api/action          prompt | stop | permission | mode | open | save
 *   GET  /api/state?token=    session + tree snapshot
 *   GET  /api/file?path=      read a file (cwd-jailed)
 *   POST /api/file            write a file (cwd-jailed)
 *   GET  /api/tree?token=     file tree JSON
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve as resolvePath, extname } from "node:path";
import { UI_HTML } from "./assets.gen.ts";
import { Agent } from "../agent.ts";
import { Session, listSessions } from "../session.ts";
import { ToolKit } from "../tools.ts";
import { loadConfig, saveConfig, splitModel, resolveRepos, type GoatConfig } from "../config.ts";
import { ProviderRegistry } from "../providers.ts";
import { resolve, resolveSmall, resolveFallbacks } from "../runtime.ts";
import { buildExtraSystem, loadOutputStyle } from "../context.ts";
import { allSkills } from "../index-shared.ts";
import { loadMcpFromConfig } from "../mcp/client.ts";
import { estimateTokens, type ContentPart } from "../llm.ts";
import { costUsd } from "../pricing.ts";
import { VERSION, WEB_DEFAULT_PORT } from "../constants.ts";
import { buildUserContent } from "../refs.ts";
import { insideRoot, SKIP_DIRS } from "../tools.ts";

interface PermReq { tool: string; args: Record<string, unknown>; resolve: (ok: boolean) => void }

const JSON_EXT = new Set([".json", ".jsonc", ".json5"]);
const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby", ".php": "php",
  ".swift": "swift", ".kt": "kotlin", ".md": "markdown", ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".less": "less", ".json": "json", ".jsonc": "json",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "ini", ".ini": "ini", ".sql": "sql",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".xml": "xml", ".svg": "xml",
  ".vue": "html", ".svelte": "html", ".lua": "lua", ".pl": "perl", ".r": "r",
  ".dart": "dart", ".graphql": "graphql", ".proto": "proto", ".tf": "hcl",
};

export interface IdeOpts { port?: number; open?: boolean }

export async function runIde(opts: IdeOpts = {}): Promise<void> {
  const cfg: GoatConfig = loadConfig();
  const registry = new ProviderRegistry(cfg.endpoints);
  const token = randomBytes(12).toString("hex");
  const port = Number(opts.port ?? process.env.GOAT_IDE_PORT ?? WEB_DEFAULT_PORT);
  const root = process.cwd();

  let session = Session.new(root, cfg.model);
  let mode = (cfg.autoApprove ? "bypass" : "default") as "default" | "acceptEdits" | "plan" | "bypass";
  let tools: ToolKit | null = null;
  let mcp: Awaited<ReturnType<typeof loadMcpFromConfig>> | null = null;
  let turnCtrl: AbortController | null = null;
  let turnBusy = false;
  const pending = new Map<string, PermReq>();
  const clients = new Set<{ controller: ReadableStreamDefaultController; enc: TextEncoder }>();
  const openFiles = new Set<string>();
  /** Ring buffer of the last events, replayed to clients that connect mid-turn. */
  const eventLog: unknown[] = [];
  const EVENT_LOG_MAX = 500;

  try { mcp = await loadMcpFromConfig({ mcpServers: cfg.mcpServers }); } catch { /* optional */ }

  function textOfLite(c: string | ContentPart[]): string {
    return typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
  }

  function broadcast(obj: unknown): void {
    eventLog.push(obj);
    if (eventLog.length > EVENT_LOG_MAX) eventLog.splice(0, eventLog.length - EVENT_LOG_MAX);
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of clients) {
      try { c.controller.enqueue(c.enc.encode(data)); }
      catch { clients.delete(c); } // client gone — drop it
    }
  }

  function buildTools(): ToolKit {
    const tk = new ToolKit(root, { autoApprove: cfg.autoApprove, rules: cfg.permissions, roots: resolveRepos(cfg.repos, root) });
    if (mode === "bypass") tk.goat = true;
    if (mode === "acceptEdits") {
      tk.permission = async (tool) => tool === "bash" || tool === "computer" ? askPerm(tool, {}) : true;
    } else if (mode === "plan") {
      tk.readonly = true;
    } else {
      tk.permission = async (tool, args) => askPerm(tool, args);
    }
    tk.hooks = cfg.hooks;
    return tk;
  }

  function askPerm(tool: string, args: Record<string, unknown>): Promise<boolean> {
    return new Promise((res) => {
      const id = randomBytes(6).toString("hex");
      pending.set(id, { tool, args, resolve: res });
      broadcast({ kind: "permission", id, tool, args });
    });
  }

  async function rebuildAgent(resumeId?: string): Promise<Agent | null> {
    const r = await resolve(cfg, registry);
    if (!tools) tools = buildTools();
    tools.goat = mode === "bypass";
    tools.readonly = mode === "plan";
    if (mcp) {
      for (const spec of mcp.specs())
        tools.registerExternal({ spec, run: (args) => mcp!.dispatch(spec.name, args) });
    }
    return new Agent({
      client: r.client, smallClient: (await resolveSmall(cfg, registry)) ?? undefined,
      fallbacks: await resolveFallbacks(cfg, registry),
      session, tools,
      maxTokens: cfg.maxTokens, temperature: cfg.temperature, maxSteps: cfg.maxSteps,
      cache: cfg.cachePrompts,
      extraSystem: [buildExtraSystem(allSkills(cfg), root, resolveRepos(cfg.repos, root)),
        loadOutputStyle(cfg.outputStyle)].filter(Boolean).join("\n\n"),
    });
  }

  function snapshotState() {
    let cost: number | null = null;
    try { cost = costUsd(session.model, session.usage) ?? null; } catch { cost = null; }
    return {
      session: { id: session.id, title: session.title, cwd: root },
      model: cfg.model,
      mode,
      version: VERSION,
      busy: turnBusy,
      usage: session.usage,
      contextTokens: session.messages.reduce((s, m) => s + estimateTokens(m.content), 0),
      cost,
      openFiles: [...openFiles],
      mcpServers: Object.keys(cfg.mcpServers).length,
      skills: allSkills(cfg).length,
    };
  }

  function broadcastState(): void {
    broadcast({ kind: "state", ...snapshotState() });
  }

  // ---------- file APIs (cwd-jailed) ----------

  function jail(relPath: string): string {
    const abs = resolvePath(root, relPath);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || resolvePath(rel) === rel) throw new Error(`path escapes workspace: ${relPath}`);
    return abs;
  }

  function fileTree(dir = root, depth = 0, maxDepth = 6): any[] {
    if (depth > maxDepth) return [];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory())
      ? a.name.localeCompare(b.name)
      : (a.isDirectory() ? -1 : 1));
    const out: any[] = [];
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github" && e.name !== ".vscode")) continue;
      const abs = join(dir, e.name);
      const rel = relative(root, abs).replaceAll("\\", "/");
      if (e.isDirectory()) {
        out.push({ name: e.name, path: rel, dir: true, children: fileTree(abs, depth + 1, maxDepth) });
      } else {
        let size = 0;
        try { size = statSync(abs).size; } catch { /* unreadable */ }
        out.push({ name: e.name, path: rel, dir: false, size, lang: LANG_BY_EXT[extname(e.name).toLowerCase()] ?? "plaintext" });
      }
      if (out.length > 2000) break;
    }
    return out;
  }

  async function runTurn(text: string): Promise<void> {
    turnBusy = true;
    broadcastState();
    try {
      const agent = await rebuildAgent();
      if (!agent) throw new Error("no usable provider — run `goat auth <provider> --key <K>` or connect a key");
      session.append({ role: "user", content: text });
      broadcast({ kind: "user", text });
      const expanded = buildUserContent(text, root);
      // re-append expanded refs (deduped: buildUserContent returns the wire content)
      session.messages.pop();
      const turn = agent.runTurn(expanded);
      turnCtrl = new AbortController();
      for await (const ev of turn) {
        if (ev.kind === "text") broadcast({ kind: "agent", ev });
        else if (ev.kind === "thinking") broadcast({ kind: "agent", ev });
        else if (ev.kind === "tool_start") broadcast({ kind: "agent", ev });
        else if (ev.kind === "tool_end") { broadcast({ kind: "agent", ev }); broadcastState(); }
        else if (ev.kind === "todo") broadcast({ kind: "agent", ev });
        else if (ev.kind === "usage") broadcast({ kind: "agent", ev });
        else if (ev.kind === "retry") broadcast({ kind: "agent", ev });
        else if (ev.kind === "fallback") broadcast({ kind: "agent", ev });
        else if (ev.kind === "error") broadcast({ kind: "error", text: ev.text });
        else if (ev.kind === "done") { broadcastState(); }
      }
    } catch (e: any) {
      broadcast({ kind: "error", text: e?.message ?? String(e) });
    } finally {
      turnBusy = false;
      turnCtrl = null;
      broadcastState();
    }
  }

  // ---------- HTTP + SSE server ----------

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff": "font/woff",
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const auth = () => url.searchParams.get("token") === token || req.headers.get("x-goat-token") === token;

    if (path === "/") {
      return new Response(UI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // vendored Monaco — immutable, local. Resolved relative to this module in
    // dev (src/ide/vendor) and to the executable's directory for compiled
    // binaries (the release workflow copies ide-vendor/ next to the binary).
    if (path.startsWith("/vendor/vs/")) {
      const rel = decodeURIComponent(path.slice("/vendor/".length)).replaceAll("\\", "/");
      if (rel.includes("..")) return new Response("forbidden", { status: 403 });
      const { dirname } = await import("node:path");
      const candidates = [
        join(import.meta.dir, "vendor", rel),
        join(dirname(process.execPath), "ide-vendor", rel),
      ];
      let body: Buffer | null = null;
      for (const file of candidates) {
        try { body = readFileSync(file); break; } catch { /* try next */ }
      }
      if (!body) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": MIME[extname(candidates[0]).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (path === "/api/events") {
      if (!auth()) return new Response("unauthorized", { status: 401 });
      const enc = new TextEncoder();
      let ping: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const client = { controller, enc };
          clients.add(client);
          // replay: anything broadcast before this client connected (capped)
          try {
            for (const past of eventLog) controller.enqueue(enc.encode(`data: ${JSON.stringify(past)}\n\n`));
          } catch { /* client vanished mid-replay */ }
          const hello = { kind: "hello", state: snapshotState(), token };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(hello)}\n\n`));
          ping = setInterval(() => {
            try { controller.enqueue(enc.encode(": ping\n\n")); } catch { /* gone */ }
          }, 20_000);
        },
        cancel() {
          if (ping) clearInterval(ping);
          // cancel() has no handle to the client entry — drop the most recently
          // added stream whose controller is unusable. Probing with a zero-byte
          // enqueue can ECONNRESET healthy streams, so sweep lazily: broadcast
          // prunes dead entries on its next enqueue failure.
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    if (path === "/api/state") {
      if (!auth()) return new Response("unauthorized", { status: 401 });
      return Response.json({ ...snapshotState(), sessions: listSessions().slice(0, 12) });
    }

    if (path === "/api/tree") {
      if (!auth()) return new Response("unauthorized", { status: 401 });
      return Response.json({ root, tree: fileTree() });
    }

    if (path === "/api/file" && req.method === "GET") {
      if (!auth()) return new Response("unauthorized", { status: 401 });
      try {
        const p = jail(url.searchParams.get("path") ?? "");
        const stat = statSync(p);
        if (stat.size > 2_000_000) return Response.json({ error: "file too large (>2MB)" }, { status: 413 });
        return Response.json({ path: url.searchParams.get("path"), content: readFileSync(p, "utf8") });
      } catch (e: any) {
        return Response.json({ error: e?.message ?? "read failed" }, { status: 400 });
      }
    }

    if (path === "/api/file" && req.method === "POST") {
      if (!auth()) return new Response("unauthorized", { status: 401 });
      try {
        const body = await req.json() as { path?: string; content?: string };
        const p = jail(String(body.path ?? ""));
        writeFileSync(p, String(body.content ?? ""), "utf8");
        openFiles.add(String(body.path));
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ error: e?.message ?? "write failed" }, { status: 400 });
      }
    }

    if (path === "/api/action" && req.method === "POST") {
      if (!auth()) return new Response("unauthorized", { status: 401 });
      const a = await req.json() as Record<string, any>;
      switch (a.action) {
        case "prompt": {
          if (turnBusy) return Response.json({ ok: false, error: "busy" });
          void runTurn(String(a.text ?? ""));
          return Response.json({ ok: true });
        }
        case "stop": {
          turnCtrl?.abort();
          return Response.json({ ok: true });
        }
        case "permission": {
          const pr = pending.get(String(a.id));
          if (pr) { pending.delete(String(a.id)); pr.resolve(!!a.allow); }
          return Response.json({ ok: true });
        }
        case "mode": {
          const m = String(a.mode ?? "default");
          if (["default", "acceptEdits", "plan", "bypass"].includes(m)) { mode = m as any; broadcastState(); }
          return Response.json({ ok: true });
        }
        case "model": {
          cfg.model = String(a.model ?? cfg.model); splitModel(cfg); saveConfig(cfg);
          session.model = cfg.model;
          broadcastState();
          return Response.json({ ok: true });
        }
        case "open": {
          const rel = String(a.path ?? "");
          openFiles.add(rel);
          broadcast({ kind: "file", path: rel, action: "open" });
          return Response.json({ ok: true });
        }
        default:
          return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
      }
    }

    return new Response("not found", { status: 404 });
  }

  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => handle(req) });
  const actual = server.port;
  const url = `http://127.0.0.1:${actual}/?token=${token}`;

  console.log("");
  console.log("  🐐 GoatCode IDE");
  console.log(`  ${url}`);
  console.log(`  workspace: ${root}`);
  console.log(`  model:     ${cfg.model}`);
  console.log("  Ctrl+C to stop");
  console.log("");

  if (opts.open) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const { spawn } = await import("node:child_process");
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  }

  await new Promise<void>((res) => {
    process.once("SIGINT", () => { server.stop(true); mcp?.shutdown?.(); res(); });
    process.once("SIGTERM", () => { server.stop(true); mcp?.shutdown?.(); res(); });
  });
}
