/**
 * goat web — the same agent engine as the TUI, in a browser UI.
 *
 * Local-only by design: binds 127.0.0.1 and requires a per-boot token in
 * the URL. Streams the live agent loop over SSE (streaming text, tool
 * rows, todos, permission dialogs, usage), and the browser POSTs back
 * prompts / decisions / mode + model changes. No new agent logic — one
 * Agent, one ToolKit, one Session shared with the CLI's semantics.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
// embedded so compiled binaries serve the UI without the src/ tree
// (regenerate after editing src/web/index.html: bun run scripts/gen-web-assets.ts)
import { UI_HTML, MARKED_JS } from "./web/assets.gen.ts";
import { Agent } from "./agent.ts";
import { Session, listSessions } from "./session.ts";
import { ToolKit } from "./tools.ts";
import { loadConfig, saveConfig, splitModel, type GoatConfig } from "./config.ts";
import { ProviderRegistry } from "./providers.ts";
import { resolve, resolveSmall } from "./runtime.ts";
import { buildExtraSystem, loadOutputStyle } from "./context.ts";
import { allSkills } from "./index-shared.ts";
import { loadMcpFromConfig } from "./mcp/client.ts";
import { estimateTokens, type ContentPart } from "./llm.ts";
import { costUsd } from "./pricing.ts";
import { cachedUpdateHint } from "./update.ts";
import { VERSION, WEB_DEFAULT_PORT } from "./constants.ts";
import { log } from "./logger.ts";
import { buildUserContent } from "./refs.ts";

interface PermReq { tool: string; args: Record<string, unknown>; resolve: (ok: boolean) => void }

export interface WebOpts { port?: number; open?: boolean }

export async function runWeb(opts: WebOpts = {}): Promise<void> {
  const cfg = loadConfig();
  const registry = new ProviderRegistry(cfg.endpoints);
  const token = randomBytes(12).toString("hex");
  const port = Number(opts.port ?? process.env.GOAT_WEB_PORT ?? WEB_DEFAULT_PORT);

  let session = Session.new(process.cwd(), cfg.model);
  let mode = (cfg.autoApprove ? "bypass" : "default") as "default" | "acceptEdits" | "plan" | "bypass";
  let toolsRef: ToolKit | null = null;
  let mcp: Awaited<ReturnType<typeof loadMcpFromConfig>> | null = null;
  let turnCtrl: AbortController | null = null;
  let turnBusy = false;
  let agentVersion = 0;               // bumped whenever model/mode changes -> UI refetches state
  const pending = new Map<string, PermReq>();
  const clients = new Set<{ controller: ReadableStreamDefaultController; enc: TextEncoder }>();

  try {
    mcp = await loadMcpFromConfig({ mcpServers: cfg.mcpServers });
  } catch { /* optional */ }

  function textOfLite(c: string | ContentPart[]): string {
    return typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
  }

  function broadcast(obj: unknown): void {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of clients) {
      try { c.controller.enqueue(c.enc.encode(data)); } catch { /* dropped */ }
    }
  }

  function statePayload(): Record<string, unknown> {
    return {
      kind: "state",
      version: VERSION,
      model: cfg.model,
      mode,
      busy: turnBusy,
      session: { id: session.id, title: session.title, cwd: session.cwd },
      usage: session.usage,
      cost: costUsd(cfg.model, session.usage.in, session.usage.out),
      contextTokens: session.context().reduce((s, m) => s + estimateTokens(m.content), 0),
      mcpServers: mcp?.servers.size ?? 0,
      skills: allSkills(cfg).length,
      update: cachedUpdateHint(),
      agentVersion,
    };
  }

  async function buildAgent(): Promise<Agent | null> {
    try {
      const r = await resolve(cfg, registry);
      const smallClient = await resolveSmall(cfg, registry);
      if (!toolsRef || toolsRef.root !== session.cwd)
        toolsRef = new ToolKit(session.cwd, { permission: () => Promise.resolve(false) });
      const tools = toolsRef;
      tools.readonly = mode === "plan";
      tools.autoApprove = mode === "bypass";
      tools.rules = cfg.permissions;
      tools.hooks = cfg.hooks;
      tools.sessionId = session.id;
      tools.permission = (t, a) =>
        mode === "acceptEdits" && (t === "write" || t === "edit")
          ? Promise.resolve(true)
          : requestPermission(t, a);
      if (mcp)
        for (const spec of mcp.specs())
          if (!tools.external.has(spec.name))
            tools.registerExternal({ spec, run: (args) => mcp!.dispatch(spec.name, args) });
      return new Agent({
        client: r.client, smallClient: smallClient ?? undefined,
        session, tools,
        maxTokens: cfg.maxTokens, temperature: cfg.temperature, maxSteps: cfg.maxSteps,
        extraSystem: [buildExtraSystem(allSkills(cfg), session.cwd),
          loadOutputStyle(cfg.outputStyle)].filter(Boolean).join("\n\n"),
      });
    } catch (e: any) {
      broadcast({ kind: "error", text: e?.message ?? String(e) });
      return null;
    }
  }

  function requestPermission(tool: string, args: Record<string, unknown>): Promise<boolean> {
    return new Promise((res) => {
      const id = randomBytes(6).toString("hex");
      pending.set(id, { tool, args, resolve: res });
      broadcast({ kind: "permission", id, tool, args });
    });
  }

  async function runTurn(text: string | ContentPart[]): Promise<void> {
    if (turnBusy) return;
    const agent = await buildAgent();
    if (!agent) return;
    turnBusy = true;
    turnCtrl = new AbortController();
    const ctrl = turnCtrl;
    broadcast({ kind: "state", ...(statePayload() as object), busy: true });
    const shown = typeof text === "string" ? text : "[image attached]";
    broadcast({ kind: "user", text: shown });
    try {
      for await (const ev of agent.runTurn(text, ctrl.signal)) {
        broadcast({ kind: "agent", ev });
      }
    } catch (e: any) {
      broadcast({ kind: "error", text: e?.message ?? String(e) });
    } finally {
      turnBusy = false;
      turnCtrl = null;
      // resolve any still-open permission dialogs as denied
      for (const [, p] of pending) p.resolve(false);
      pending.clear();
      broadcast({ kind: "state", ...(statePayload() as object), busy: false });
    }
  }

  async function handleAction(body: any): Promise<unknown> {
    switch (body?.action) {
      case "prompt": {
        const raw = String(body.text ?? "").trim();
        if (!raw) return { ok: false, error: "empty prompt" };
        // native slash subset; everything else runs as a plain prompt in the loop
        if (raw === "/new" || raw === "/clear") {
          if (raw === "/new") { session.save(); session = Session.new(process.cwd(), cfg.model); }
          else { session.messages = []; session.compactedFrom = 0; }
          broadcast({ kind: "cleared" });
          return { ok: true, ...statePayload() };
        }
        if (raw === "/stop" && turnCtrl) { turnCtrl.abort(); return { ok: true }; }
        if (raw === "/undo") {
          const n = toolsRef?.undoCheckpoint() ?? -1;
          broadcast({ kind: "note", text: n <= 0 ? "nothing to undo from the last turn" : `reverted ${n} file mutation(s)` });
          return { ok: true };
        }
        if (raw.startsWith("/model ")) {
          const next = raw.slice(7).trim();
          if (next) { cfg.model = next; splitModel(cfg); saveConfig(cfg); agentVersion++; broadcast({ kind: "state", ...statePayload() as object }); }
          return { ok: true };
        }
        if (raw === "/compact") {
          const agent = await buildAgent();
          if (!agent) return { ok: false, error: "no usable client" };
          const r = await agent.compactNow();
          broadcast({ kind: "note", text: r.folded ? `summarized ${r.folded} older messages` : "nothing to compact" });
          return { ok: true };
        }
        if (raw.startsWith("/")) {
          broadcast({ kind: "note", text: `${raw.split(" ")[0]} is terminal-only; the web UI supports /new /clear /compact /undo /model /stop` });
          return { ok: true };
        }
        void runTurn(buildUserContent(raw, session.cwd));
        return { ok: true };
      }
      case "permission": {
        const p = pending.get(String(body.id));
        if (!p) return { ok: false, error: "stale dialog" };
        pending.delete(String(body.id));
        p.resolve(Boolean(body.allow));
        if (body.allow && body.allEdits) mode = "acceptEdits";
        broadcast({ kind: "state", ...statePayload() as object });
        return { ok: true };
      }
      case "stop":
        turnCtrl?.abort();
        return { ok: true };
      case "mode": {
        const m = String(body.mode);
        if (["default", "acceptEdits", "plan", "bypass"].includes(m)) {
          mode = m as typeof mode;
          cfg.autoApprove = m === "bypass";
        }
        broadcast({ kind: "state", ...statePayload() as object });
        return { ok: true };
      }
      case "model": {
        const next = String(body.model ?? "").trim();
        if (next) {
          cfg.model = next; splitModel(cfg); saveConfig(cfg); agentVersion++;
          broadcast({ kind: "state", ...statePayload() as object });
        }
        return { ok: true };
      }
      case "resume": {
        const id = String(body.id ?? "");
        try { session.save(); } catch { /* */ }
        session = Session.loadById(id);
        cfg.model = session.model || cfg.model; splitModel(cfg);
        broadcast({ kind: "restore", messages: session.context().map((m) => ({
          role: m.role,
          text: typeof m.content === "string" ? m.content : "[multimodal]",
          tools: m.toolCalls?.map((tc) => tc.name) ?? [],
        })) });
        broadcast({ kind: "state", ...statePayload() as object });
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown action ${body?.action}` };
    }
  }

  const authed = (req: Request): boolean => {
    const u = new URL(req.url);
    return u.searchParams.get("token") === token ||
      req.headers.get("x-goat-token") === token;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: {
      "/vendor/marked.umd.js": () => new Response(MARKED_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
      "/": (req: Request) => {
        if (!authed(req)) return new Response("unauthorized — use the URL printed by `goat web`", { status: 401 });
        return new Response(UI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
      "/api/events": (req: Request) => {
        if (!authed(req)) return new Response("unauthorized", { status: 401 });
        const enc = new TextEncoder();
        let client: { controller: ReadableStreamDefaultController; enc: TextEncoder };
        const stream = new ReadableStream({
          start(controller) {
            client = { controller, enc };
            clients.add(client);
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "hello", state: statePayload() })}\n\n`));
            // replay the current transcript so a refresh / second tab shows history
            const history = session.context().flatMap((m) => {
              if (m.role === "user")
                return [{ kind: "replay", msg: { role: "user", text: textOfLite(m.content) } }];
              if (m.role === "assistant") {
                const rows: any[] = [];
                const t = textOfLite(m.content);
                if (t) rows.push({ kind: "replay", msg: { role: "assistant", text: t } });
                for (const tc of m.toolCalls ?? [])
                  rows.push({ kind: "replay", msg: { role: "tool", tool: tc.name, args: tc.arguments } });
                return rows;
              }
              if (m.role === "tool")
                return [{ kind: "replay", msg: { role: "toolresult", tool: m.name ?? "", ok: true, text: textOfLite(m.content).slice(0, 2000) } }];
              return [];
            });
            for (const h of history) { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(h)}\n\n`)); } catch { break; } }
          },
          cancel() { clients.delete(client!); },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      },
    },
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (!authed(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/api/action" && req.method === "POST") {
        try {
          const body = await req.json();
          return Response.json(await handleAction(body));
        } catch (e: any) {
          return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/sessions") {
        return Response.json({ sessions: listSessions().slice(0, 30) });
      }
      if (url.pathname === "/api/providers") {
        const ready = registry.listAll().filter((p) => registry.resolveCredential(p.id));
        return Response.json({
          providers: ready.map((p) => ({ id: p.id, models: p.models.slice(0, 12) })),
          model: cfg.model,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const url = `http://localhost:${port}/?token=${token}`;
  console.log(`\n  GoatCode web ui  →  ${url}`);
  console.log(`  (localhost-only; this URL is the key — close the tab + quit to revoke)\n`);
  log("web", `serving on 127.0.0.1:${port}`);
  if (opts.open !== false) {
    try {
      const [bin, args] = process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      spawn(bin, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
    } catch { /* manual open */ }
  }
  // keep alive
  await new Promise<void>((res) => { process.on("SIGINT", () => { server.stop(true); res(); }); });
}
