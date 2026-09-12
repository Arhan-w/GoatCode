/**
 * Helpers shared between the CLI entry (index.ts), the TUI, and the web UI —
 * kept out of index.ts so importing them never re-runs main().
 */
import { join } from "node:path";
import { appDir, type GoatConfig, resolveRepos } from "./config.ts";
import { loadSkills, type SkillDef } from "./skills/loader.ts";
import { loadPlugins, pluginSkills } from "./plugins/loader.ts";
import { resolve, resolveSmall, resolveFallbacks } from "./runtime.ts";
import { Agent } from "./agent.ts";
import { ToolKit } from "./tools.ts";
import { Session } from "./session.ts";
import { buildExtraSystem, loadOutputStyle } from "./context.ts";
import { buildUserContent } from "./refs.ts";
import { costUsd } from "./pricing.ts";
import type { ProviderRegistry } from "./providers.ts";

export interface PrintTurnResult { text: string; session: Session; failed: string; }

/** Extract the body of the -p print-mode block so index.ts and tests share it. */
export async function runPrintTurn(opts: {
  prompt: string; cfg: GoatConfig; registry: ProviderRegistry; json?: boolean; quiet?: boolean;
  stdinText?: string; cwd?: string; out?: (s: string) => void; status?: (s: string) => void;
}): Promise<PrintTurnResult> {
  const { prompt, cfg, registry, json = false, quiet = false, stdinText, cwd, out = (s: string) => {}, status = () => {} } = opts;
  const query = prompt === "" || prompt === "-" ? stdinText : stdinText ? `${stdinText}\n\n${prompt}` : prompt;
  if (!query) return { text: "", session: Session.new(process.cwd(), cfg.model), failed: "nothing to do: pass a prompt to -p or pipe text on stdin" };
  const r = await resolve(cfg, registry);
  const session = Session.new(cwd ?? process.cwd(), cfg.model);
  const tools = new ToolKit(cwd ?? process.cwd(), { autoApprove: cfg.autoApprove, rules: cfg.permissions, roots: resolveRepos(cfg.repos, cwd ?? process.cwd()) });
  tools.hooks = cfg.hooks;
  let mcp: any = null;
  if (Object.keys(cfg.mcpServers).length) {
    try {
      const { loadMcpFromConfig } = await import("./mcp/client.ts");
      mcp = await loadMcpFromConfig({ mcpServers: cfg.mcpServers });
      for (const spec of mcp.specs()) tools.registerExternal({ spec, run: (args) => mcp!.dispatch(spec.name, args) });
    } catch { /* mcp optional in print mode */ }
  }
  await registerRemoteAgents(cfg, tools);
  const agent = new Agent({
    client: r.client, smallClient: (await resolveSmall(cfg, registry)) ?? undefined,
    fallbacks: await resolveFallbacks(cfg, registry),
    session, tools,
    maxTokens: cfg.maxTokens, temperature: cfg.temperature, maxSteps: cfg.maxSteps,
    cache: cfg.cachePrompts,
    extraSystem: [buildExtraSystem(allSkills(cfg), cwd ?? process.cwd(), resolveRepos(cfg.repos, cwd ?? process.cwd())),
      loadOutputStyle(cfg.outputStyle)].filter(Boolean).join("\n\n"),
  });
  let outText = "";
  let failed = "";
  const expandedPrompt = buildUserContent(query, cwd ?? process.cwd());
  for await (const ev of agent.runTurn(expandedPrompt)) {
    if (ev.kind === "text") { outText += ev.text; if (!quiet) out(ev.text); }
    else if (ev.kind === "tool_start" && !quiet) out(`\n[tool ${ev.tool} ${JSON.stringify(ev.args).slice(0, 100)}]\n`);
    else if (ev.kind === "retry") out(`\n[retry attempt ${ev.attempt + 1} in ${(ev.waitMs / 1000).toFixed(1)}s: ${ev.reason}]\n`);
    else if (ev.kind === "error") failed = ev.text;
  }
  await mcp?.shutdown();
  session.save();
  if (json) {
    const cost = costUsd(session.model, session.usage);
    const envelope = {
      type: "result",
      subtype: failed ? "error" : "success",
      is_error: !!failed,
      ...(failed ? { error: failed } : { result: outText }),
      session_id: session.id,
      model: session.model,
      usage: { input_tokens: session.usage.in, output_tokens: session.usage.out },
      ...(cost != null ? { cost_usd: +cost.toFixed(6) } : {}),
    };
    return { text: JSON.stringify(envelope) + "\n", session, failed };
  }
  if (failed) { out(`\nerror: ${failed}\n`); }
  if (outText && !quiet && !failed) out("\n");
  return { text: outText, session, failed };
}

/**
 * Mount every registered remote goat agent as a local `remote_<name>` tool.
 * Tokens are never persisted: they're read from GOAT_REMOTE_TOKEN_<NAME> at
 * call time. Agents without a token in the env are skipped silently.
 */
export async function registerRemoteAgents(cfg: GoatConfig, tools: ToolKit): Promise<number> {
  let n = 0;
  if (!(cfg.remoteAgents ?? []).length) return 0;
  const { RemoteGoat, remoteToolSpec, makeRemoteToolHandler, remoteTokenEnv } = await import("./protocol/client.ts");
  for (const a of cfg.remoteAgents ?? []) {
    const token = process.env[remoteTokenEnv(a.name)] ?? "";
    if (!token) continue;
    const remote = new RemoteGoat({ url: a.url, name: a.name, token });
    tools.registerExternal({
      spec: remoteToolSpec(remote),
      run: async (args) => makeRemoteToolHandler(remote)(args),
      mutating: true, // remote agents run tools on another machine — always ask
    });
    n++;
  }
  return n;
}

/** Native skills (user/project/claude dirs) extended by anything plugins provide. */
export function allSkills(cfg: GoatConfig): SkillDef[] {
  const native = loadSkills(
    join(appDir(), "skills"),
    join(process.cwd(), "skills"),
    join(process.cwd(), ".claude", "skills"),
  );
  const fromPlugins = pluginSkills(loadPlugins(cfg.pluginDirs.map((d) => join(process.cwd(), d))));
  const names = new Set(native.map((s) => s.name));
  return [...native, ...fromPlugins.filter((s) => !names.has(s.name))];
}
