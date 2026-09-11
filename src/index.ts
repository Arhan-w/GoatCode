/**
 * goat — command line entrypoint.
 *
 *   goat                          interactive TUI
 *   goat -p "fix the tests"       one-shot prompt, prints result and exits
 *   cat err.log | goat -p "why?"  piped stdin becomes context for the prompt
 *   goat -p --output-format json  machine-readable result for scripts and CI
 *   goat auth <provider> --key K  store API key
 *   goat auth <provider> --oauth  browser/device OAuth login
 *   goat providers [--check]      list providers
 *   goat endpoint add <id> ...    register a custom endpoint
 *   goat addp <id> --base-url ... shorthand: add a provider + key + models
 *   goat config set fallback-models '["b/x","c/y"]'  provider failover chain
 *   goat models <provider>        list catalog models
 *   goat sessions                 list saved sessions
 *   goat resume <id>              resume a session in the TUI
 *   goat -c | --continue          resume the most recent session
 *   goat mcp add <name> <cmd>     add an MCP server
 */
import { run } from "./tui.tsx";
import { buildUserContent } from "./refs.ts";
import { appDir, configPath, loadConfig, saveConfig, splitModel, type CustomEndpoint, type WireFormat } from "./config.ts";
import { CredentialStore, OAUTH_PROVIDERS, ProviderRegistry, normalizeBaseUrl, type Credential } from "./providers.ts";
import { listSessions } from "./session.ts";
import { loginDevice, loginImport, loginOauth, type LoginIO } from "./oauth.ts";
import { resolve, resolveSmall, resolveFallbacks } from "./runtime.ts";
import { costUsd } from "./pricing.ts";
import { Agent } from "./agent.ts";
import { ToolKit } from "./tools.ts";
import { Session } from "./session.ts";
import { loadSkills } from "./skills/loader.ts";
import { loadPlugins, pluginSkills } from "./plugins/loader.ts";
import { buildExtraSystem, loadOutputStyle } from "./context.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoatConfig } from "./config.ts";
import { VERSION } from "./constants.ts";
import { selfUpdate, checkForUpdate, refreshUpdateHint } from "./update.ts";

import { allSkills } from "./index-shared.ts";
export { allSkills };

const io: LoginIO = {
  print: (s) => console.log(s),
  prompt: async (q) => {
    process.stdout.write(q);
    for await (const line of console) return line.trim();
    return "";
  },
};

// raw config access for `goat config` — reads/writes the JSON file directly
function loadConfigRaw(): Record<string, any> {
  try { return JSON.parse(readFileSync(configPath(), "utf8")); } catch { return {}; }
}
function saveConfigRaw(data: Record<string, any>): void {
  mkdirSync(appDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(data, null, 2) + "\n", "utf8");
}
function snakeToCamel(k: string): string {
  return k.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
}
function camelToSnake(k: string): string {
  return k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}
/** All spellings a key can appear under on disk / from the user. */
function keyVariants(k: string): string[] {
  const camel = snakeToCamel(k), snake = camelToSnake(k);
  return [...new Set([k, camel, snake, k.replace(/_/g, "-")])];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const registry = new ProviderRegistry(cfg.endpoints);

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);

  if (has("--version") || has("-V")) { console.log(`goatcode ${VERSION}`); return 0; }
  const m = flag("-m") ?? flag("--model");
  if (m) { cfg.model = m; splitModel(cfg); }
  if (has("--auto")) cfg.autoApprove = true;

  const sub = argv[0];

  // goat self-update [--check] — swap the running binary for the latest release
  if (sub === "self-update" || sub === "update") {
    if (has("--check")) {
      const rel = await checkForUpdate();
      if (rel) console.log(`update available: ${VERSION} -> ${rel.version}\n  ${rel.url}\n  run: goat self-update`);
      else console.log(`goatcode ${VERSION} is the latest release.`);
      return 0;
    }
    console.log(`goatcode ${VERSION} — checking for updates...`);
    const r = await selfUpdate((s) => console.log(s));
    console.log((r.ok ? "" : "error: ") + r.message);
    return r.ok ? 0 : 1;
  }

  // goat addp <id> --base-url URL [--format openai|claude|gemini|openai-responses] [--api-key KEY] [--api-key-env ENV] [--models m1,m2,...]
  if (sub === "addp") {
    const id = argv[1];
    if (!id) { console.log("usage: goat addp <id> --base-url URL [--format openai|claude|gemini|openai-responses] [--api-key KEY] [--api-key-env ENV] [--models m1,m2,...]"); return 1; }
    const baseUrl = flag("--base-url");
    if (!baseUrl) { console.log("addp requires --base-url"); return 1; }
    const format = (flag("--format") ?? "openai") as WireFormat;
    const apiKey = flag("--api-key");
    const apiKeyEnv = flag("--api-key-env");
    const models = (flag("--models") ?? "").split(",").filter(Boolean);
    if (!apiKey && !apiKeyEnv) { console.log("addp requires --api-key or --api-key-env"); return 1; }
    cfg.endpoints[id] = {
      id, baseUrl: normalizeBaseUrl(baseUrl),
      format,
      apiKey: apiKey ?? undefined,
      apiKeyEnv: apiKeyEnv ?? undefined,
      models,
      label: flag("--label") ?? id,
    };
    saveConfig(cfg);
    console.log(`added provider '${id}' (${format}) -> ${baseUrl}`);
    return 0;
  }

  if (sub === "auth") {
    const pid = argv[1];
    if (has("--list-oauth")) {
      for (const [k, meta] of Object.entries(OAUTH_PROVIDERS)) console.log(`  ${k.padEnd(16)} ${meta.label}`);
      return 0;
    }
    if (!pid) {
      // interactive picker: nobody memorizes provider ids
      const opts = Object.entries(OAUTH_PROVIDERS);
      console.log("Which provider do you want to authenticate?");
      opts.forEach(([k, meta], i) => console.log(`  ${String(i + 1).padStart(2)}. ${k.padEnd(16)} ${meta.label}`));
      console.log(`   ${opts.length + 1}. other — paste an API key for any provider id`);
      const pick = (await io.prompt("goat auth> ")).trim();
      const n = Number(pick);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) {
        const [key, meta] = opts[n - 1];
        console.log(`\n${meta.label}`);
        console.log(`  browser/device login:  goat auth ${key} --oauth`);
        console.log(`  paste API key instead: goat auth ${key} --key <K>`);
        const how = (await io.prompt("goat auth> (o)auth or (k)ey? ")).trim().toLowerCase();
        if (how.startsWith("o")) {
          const flow = meta.flow ?? "browser";
          const cred = flow === "device" ? await loginDevice(key, io)
            : flow === "import" ? await loginImport(key, io)
            : await loginOauth(key, io);
          registry.store.put(key, cred);
          console.log(`logged in to ${key} — try: goat -m ${key}/... "hello"`);
          return 0;
        }
        const k2 = (await io.prompt("paste API key: ")).trim();
        if (!k2) { console.log("no key entered"); return 1; }
        registry.store.put(key, { kind: "api_key", apiKey: k2, expiresAt: 0 });
        console.log(`stored API key for ${key}`);
        return 0;
      }
      const other = (await io.prompt("provider id (see: goat providers): ")).trim();
      if (!other) { console.log("no provider entered"); return 1; }
      const k3 = (await io.prompt("paste API key: ")).trim();
      if (!k3) { console.log("no key entered"); return 1; }
      registry.store.put(other, { kind: "api_key", apiKey: k3, expiresAt: 0 });
      console.log(`stored API key for ${other} — try: goat -m ${other}/<model> "hello"`);
      return 0;
    }
    const key = flag("--key");
    if (key) { registry.store.put(pid, { kind: "api_key", apiKey: key, expiresAt: 0 }); console.log(`stored API key for ${pid}`); return 0; }
    if (has("--oauth")) {
      const meta = OAUTH_PROVIDERS[pid];
      if (!meta) { console.error(`no OAuth flow for '${pid}'`); return 1; }
      const flow = meta.flow ?? "browser";
      const cred = flow === "device" ? await loginDevice(pid, io)
        : flow === "import" ? await loginImport(pid, io)
        : await loginOauth(pid, io, has("--manual"));
      registry.store.put(pid, cred);
      console.log(`logged in to ${pid} — try: goat -m ${pid}/... "hello"`);
      return 0;
    }
    console.log("usage: goat auth <provider> --key <K> | --oauth");
    return 1;
  }

  if (sub === "providers") {
    for (const p of registry.listAll()) {
      const mark = registry.resolveCredential(p.id) ? "✓" : " ";
      console.log(` ${mark} ${p.id.padEnd(30)} [${p.format}] ${p.baseUrl}`);
    }
    if (has("--check")) {
      const missing = registry.listAll().filter((p) => !registry.resolveCredential(p.id)).length;
      console.log(`\n${missing} providers without credentials.`);
    }
    return 0;
  }

  if (sub === "models") {
    const pid = argv[1];
    const p = pid ? registry.get(pid) : undefined;
    if (!p) { console.error("usage: goat models <provider>"); return 1; }
    for (const mm of p.models.length ? p.models : ["(no catalog models — pass any model id)"])
      console.log(`  ${p.id}/${mm}`);
    return 0;
  }

  if (sub === "endpoint") {
    const action = argv[1], id = argv[2];
    if (action === "add" && id) {
      const ep: CustomEndpoint = {
        id, baseUrl: (flag("--base-url") ?? "").replace(/\/+$/, ""),
        format: (flag("--format") ?? "openai") as CustomEndpoint["format"],
        apiKey: flag("--api-key"), apiKeyEnv: flag("--api-key-env"),
        models: (flag("--models") ?? "").split(",").filter(Boolean),
        label: flag("--label") ?? id,
      };
      if (!ep.baseUrl) { console.error("add requires --base-url"); return 1; }
      cfg.endpoints[id] = ep;
      saveConfig(cfg);
      console.log(`added endpoint '${id}' (${ep.format}) -> ${ep.baseUrl}`);
      return 0;
    }
    if (action === "remove" && id && cfg.endpoints[id]) {
      delete cfg.endpoints[id];
      saveConfig(cfg);
      console.log(`removed endpoint '${id}'`);
      return 0;
    }
    if (action === "list") {
      for (const [pid, ep] of Object.entries(cfg.endpoints)) console.log(`  ${pid.padEnd(20)} [${ep.format}] ${ep.baseUrl}`);
      return 0;
    }
    console.log("usage: goat endpoint add|remove|list <id> [--base-url URL ...]");
    return 1;
  }

  if (sub === "mcp") {
    // goat mcp add <name> <command> [args...] | --transport http <name> <url>
    const action = argv[1];
    if (action === "add") {
      const transport = flag("--transport");
      const name = argv[2];
      if (!name) { console.log("usage: goat mcp add [--transport http|sse] <name> <command|url> [args...]"); return 1; }
      if (transport === "http" || transport === "sse") {
        const url = argv[3];
        if (!url) { console.log("missing url"); return 1; }
        cfg.mcpServers[name] = { type: transport, url } as any;
      } else {
        const command = argv[3];
        if (!command) { console.log("missing command"); return 1; }
        // `goat mcp add name -- cmd args...` — drop the `--` separator
        const args = argv.slice(4);
        cfg.mcpServers[name] = { type: "stdio", command, args: args[0] === "--" ? args.slice(1) : args };
      }
      saveConfig(cfg);
      console.log(`added MCP server '${name}'`);
      return 0;
    }
    if (action === "list") {
      for (const [name, sc] of Object.entries(cfg.mcpServers))
        console.log(`  ${name.padEnd(20)} ${"command" in sc ? sc.command + " " + (sc.args ?? []).join(" ") : sc.url}`);
      if (!Object.keys(cfg.mcpServers).length) console.log("  (no MCP servers — add with: goat mcp add <name> -- npx my-server)");
      return 0;
    }
    if (action === "remove" && argv[2] && cfg.mcpServers[argv[2]]) {
      delete cfg.mcpServers[argv[2]];
      saveConfig(cfg);
      console.log(`removed MCP server '${argv[2]}'`);
      return 0;
    }
    console.log("usage: goat mcp add|list|remove ...");
    return 1;
  }

  if (sub === "sessions") {
    for (const row of listSessions())
      console.log(`  ${row.id}  ${row.model.padEnd(34)} ${row.title.slice(0, 60)}`);
    return 0;
  }

  // goat config [get <key> | set <key> <value> | unset <key> | path]
  if (sub === "config") {
    const action = argv[1];
    if (!action || action === "list" || action === "path") {
      if (action === "path") { console.log(configPath()); return 0; }
      const data = { ...loadConfigRaw() };
      for (const [k, v] of Object.entries(data))
        console.log(`  ${k.padEnd(18)} ${JSON.stringify(v)}`);
      return 0;
    }
    if (action === "get" || action === "set" || action === "unset") {
      const key = argv[2];
      if (!key) { console.log(`usage: goat config ${action} <key>${action === "set" ? " <value>" : ""}`); return 1; }
      const data = { ...loadConfigRaw() };
      if (action === "get") {
        for (const v of keyVariants(key)) {
          if (data[v] !== undefined) { console.log(JSON.stringify(data[v])); return 0; }
        }
        console.log(`${key}: not set`);
        return 1;
      }
      if (action === "unset") {
        for (const v of keyVariants(key)) delete data[v];
        saveConfigRaw(data);
        console.log(`unset ${key}`);
        return 0;
      }
      const rawVal = argv[3];
      if (rawVal === undefined) { console.log("missing value"); return 1; }
      let val: unknown = rawVal;
      if (rawVal === "true") val = true;
      else if (rawVal === "false") val = false;
      else if (/^[[{"]/.test(rawVal)) {
        try { val = JSON.parse(rawVal); } catch { console.log(`invalid JSON value: ${rawVal}`); return 1; }
      }
      else if (rawVal !== "" && !isNaN(Number(rawVal))) val = Number(rawVal);
      for (const v of keyVariants(key)) delete data[v];
      data[snakeToCamel(key)] = val;
      saveConfigRaw(data);
      console.log(`${key} = ${JSON.stringify(val)}`);
      return 0;
    }
    console.log("usage: goat config [list|path|get <k>|set <k> <v>|unset <k>]  (values: JSON parsed for arrays/objects)")
    return 1;
  }

  if (sub === "resume") {
    await run(cfg, argv[1]);
    return 0;
  }

  // goat -c / --continue — jump straight back into the most recent session
  if ((sub === "-c" || sub === "--continue" || has("-c") || has("--continue")) && !flag("-p") && !flag("--print")) {
    const last = listSessions()[0];
    if (!last) { console.log("no sessions to continue yet"); return 0; }
    console.log(`resuming ${last.id} — ${last.title}`);
    await run(cfg, last.id);
    return 0;
  }

  // one-shot print mode — goat -p "fix the tests" [--output-format json] [-q]
  // Accepts piped stdin too: `cat error.log | goat -p "why did this fail"`
  // sends the log as context with the query; `goat -p -` reads the whole
  // prompt from stdin. --output-format json prints one result object on
  // stdout (everything else goes to stderr) for scripts and CI.
  const prompt = flag("-p") ?? flag("--print") ?? ((argv[argv.length - 1] === "-p" || argv[argv.length - 1] === "--print") ? "" : undefined);
  if (prompt !== undefined) {
    const json = flag("--output-format") === "json";
    const quiet = has("-q") || json;
    let stdinText = "";
    if (!process.stdin.isTTY) {
      const chunks: string[] = [];
      for await (const c of process.stdin) chunks.push(typeof c === "string" ? c : (c as Buffer).toString("utf8"));
      stdinText = chunks.join("").trim();
    }
    const query = (prompt === "" || prompt === "-") ? stdinText
      : stdinText ? `${stdinText}\n\n${prompt}` : prompt;
    if (!query) { console.error("nothing to do: pass a prompt to -p or pipe text on stdin"); return 1; }
    const r = await resolve(cfg, registry);
    const session = Session.new(process.cwd(), cfg.model);
    const tools = new ToolKit(process.cwd(), { autoApprove: cfg.autoApprove, rules: cfg.permissions });
    tools.hooks = cfg.hooks;
    let mcp = null;
    if (Object.keys(cfg.mcpServers).length) {
      try {
        const { loadMcpFromConfig } = await import("./mcp/client.ts");
        mcp = await loadMcpFromConfig({ mcpServers: cfg.mcpServers });
        for (const spec of mcp.specs())
          tools.registerExternal({ spec, run: (args) => mcp!.dispatch(spec.name, args) });
      } catch { /* mcp optional in print mode */ }
    }
    const agent = new Agent({
      client: r.client, smallClient: (await resolveSmall(cfg, registry)) ?? undefined,
      fallbacks: await resolveFallbacks(cfg, registry),
      session, tools,
      maxTokens: cfg.maxTokens, temperature: cfg.temperature, maxSteps: cfg.maxSteps,
      cache: cfg.cachePrompts,
      extraSystem: [buildExtraSystem(allSkills(cfg), process.cwd()),
        loadOutputStyle(cfg.outputStyle)].filter(Boolean).join("\n\n"),
    });
    let out = "";
    let failed = "";
    const expandedPrompt = buildUserContent(query, process.cwd());
    for await (const ev of agent.runTurn(expandedPrompt)) {
      if (ev.kind === "text") { out += ev.text; if (!quiet) process.stdout.write(ev.text); }
      else if (ev.kind === "tool_start" && !quiet) process.stderr.write(`\n[tool ${ev.tool} ${JSON.stringify(ev.args).slice(0, 100)}]\n`);
      else if (ev.kind === "retry") process.stderr.write(`\n[retry attempt ${ev.attempt + 1} in ${(ev.waitMs / 1000).toFixed(1)}s: ${ev.reason}]\n`);
      else if (ev.kind === "error") failed = ev.text;
    }
    await mcp?.shutdown();
    session.save();
    if (json) {
      // session.model tracks a mid-turn failover — report the model that answered
      const cost = costUsd(session.model, session.usage);
      process.stdout.write(JSON.stringify({
        type: "result",
        subtype: failed ? "error" : "success",
        is_error: !!failed,
        ...(failed ? { error: failed } : { result: out }),
        session_id: session.id,
        model: session.model,
        usage: { input_tokens: session.usage.in, output_tokens: session.usage.out },
        ...(cost != null ? { cost_usd: +cost.toFixed(6) } : {}),
      }) + "\n");
    } else if (failed) {
      process.stderr.write(`\nerror: ${failed}\n`);
    }
    if (out && !quiet && !failed) process.stdout.write("\n");
    return failed ? 1 : 0;
  }

  // interactive TUI — await so the process lives until the app exits
  await run(cfg);
  return 0;
}

// only run when executed directly — web.ts imports helpers from here
if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
