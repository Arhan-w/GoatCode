/** JSON-RPC serve — Bun.serve with POST /rpc, /health, agent.capabilities, sessions.list. */
import { Agent } from "../agent.ts";
import { ToolKit } from "../tools.ts";
import { Session } from "../session.ts";
import { listSessions } from "../session.ts";
import { resolve as resolveRuntime, resolveSmall, resolveFallbacks } from "../runtime.ts";
import { costUsd } from "../pricing.ts";
import { buildExtraSystem, loadOutputStyle } from "../context.ts";
import { allSkills } from "../index-shared.ts";
import { buildUserContent } from "../refs.ts";
import { resolveRepos, type GoatConfig } from "../config.ts";
import { resolve as resolvePath } from "node:path";
import { VERSION } from "../constants.ts";
import { tokenOk } from "./rpc.ts";
import { ProviderRegistry } from "../providers.ts";
import { ToolSpec } from "../llm.ts";

export interface ServeOpts {
  cfg: GoatConfig;
  registry: ProviderRegistry;
  port?: number;
  token: string;
}

export interface ServeHandle { url: string; port: number; close(): void }

/** Builtin tool names a remote agent exposes (bash excluded — it's dangerous over RPC). */
function remoteToolNames(cwd: string, cfg: GoatConfig): string[] {
  const tk = new ToolKit(cwd, { autoApprove: cfg.autoApprove, rules: cfg.permissions, roots: resolveRepos(cfg.repos, process.cwd()) });
  return tk.specs().map((s) => s.name).filter((n) => n !== "bash");
}

export async function startServe(opts: ServeOpts): Promise<ServeHandle> {
  const { cfg, registry, token } = opts;
  if (!token) throw new Error("goat serve refuses to start without GOAT_AGENT_TOKEN");
  const port = opts.port ?? 8788;
  const cwd = process.cwd();
  const roots = resolveRepos(cfg.repos, cwd);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // Only POST allowed on /rpc
      if (url.pathname === "/rpc") {
        if (req.method !== "POST") return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method not allowed" } }), { status: 405, headers: { "Content-Type": "application/json" } });
        const auth = req.headers.get("Authorization");
        const given = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!tokenOk(given, token)) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Unauthorized" } }), { status: 401, headers: { "Content-Type": "application/json" } });
        // Body cap 1MB
        const body = await req.text();
        if (body.length > 1_000_000) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "Request too large" } }), { status: 413, headers: { "Content-Type": "application/json" } });
        const { parseRequest } = await import("./rpc.ts");
        const parsed = parseRequest(body);
        if (!parsed.ok) return new Response(JSON.stringify(parsed.error), { status: 400, headers: { "Content-Type": "application/json" } });
        const { id, method, params } = parsed;
        if (method === "agent.capabilities") {
          const tools = remoteToolNames(cwd, cfg);
          return new Response(JSON.stringify({ jsonrpc: "2.0", result: { name: "goat", version: VERSION, methods: ["agent.run", "agent.capabilities", "sessions.list"], tools }, id }));
        }
        if (method === "sessions.list") {
          const limit = typeof (params as Record<string, unknown>)?.limit === "number" ? (params as Record<string, unknown>).limit as number : undefined;
          const rows = listSessions();
          return new Response(JSON.stringify({ jsonrpc: "2.0", result: { rows: limit ? rows.slice(0, limit) : rows }, id }));
        }
        if (method === "agent.run") {
          const p = params as Record<string, unknown>;
          const prompt = typeof p?.prompt === "string" ? p.prompt : undefined;
          const reqCwd = typeof p?.cwd === "string" ? p.cwd as string : cwd;
          if (!prompt) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "prompt is required and must be a string" }, id }));
          // cwd must be inside one of resolveRepos(cfg.repos, cwd) values or cwd itself
          const allowed = Object.values(roots);
          const resolvedReq = resolvePath(reqCwd);
          const cwdAbs = resolvePath(cwd);
          const okCwd = resolvedReq === cwdAbs || allowed.some((r) => resolvedReq === r || resolvedReq.startsWith(r + "/"));
          if (!okCwd) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "cwd outside allowed roots" }, id }));
          try {
            const r = await resolveRuntime(cfg, registry);
            const session = Session.new(reqCwd, cfg.model);
            const tools = new ToolKit(reqCwd, { autoApprove: cfg.autoApprove, rules: cfg.permissions, roots });
            tools.hooks = cfg.hooks;
            let mcp = null;
            if (Object.keys(cfg.mcpServers).length) {
              try {
                const { loadMcpFromConfig } = await import("../mcp/client.ts");
                mcp = await loadMcpFromConfig({ mcpServers: cfg.mcpServers });
                for (const spec of mcp.specs()) tools.registerExternal({ spec, run: (args) => mcp!.dispatch(spec.name, args) });
              } catch { /* mcp optional */ }
            }
            const agent = new Agent({
              client: r.client, smallClient: (await resolveSmall(cfg, registry)) ?? undefined,
              fallbacks: await resolveFallbacks(cfg, registry),
              session, tools,
              maxTokens: cfg.maxTokens, temperature: cfg.temperature, maxSteps: cfg.maxSteps,
              cache: cfg.cachePrompts,
              extraSystem: [buildExtraSystem(allSkills(cfg), reqCwd, roots), loadOutputStyle(cfg.outputStyle)].filter(Boolean).join("\n\n"),
            });
            let out = "";
            let failed = "";
            const expanded = buildUserContent(prompt, reqCwd);
            for await (const ev of agent.runTurn(expanded)) {
              if (ev.kind === "text") out += ev.text;
              else if (ev.kind === "error") failed = ev.text;
            }
            await mcp?.shutdown();
            session.save();
            const cost = costUsd(session.model, session.usage);
            return new Response(JSON.stringify({
              jsonrpc: "2.0", result: { text: out, session_id: session.id, model: session.model, usage: { input_tokens: session.usage.in, output_tokens: session.usage.out }, ...(cost != null ? { cost_usd: +cost.toFixed(6) } : {}) }, id,
            }));
          } catch (e: unknown) {
            return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message } }));
          }
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id }));
      }
      if (url.pathname === "/health") {
        if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
        return new Response("ok");
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const actual = server.port ?? 0;
  return { url: `http://127.0.0.1:${actual}`, port: actual, close: () => server.stop(true) };
}
