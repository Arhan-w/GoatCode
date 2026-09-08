/**
 * Slash commands — Claude Code-style palette.
 * Each command gets a SlashIO context; returns true if handled.
 */
import type { ReactNode } from "react";
import type { GoatConfig } from "./config.ts";
import { saveConfig, splitModel } from "./config.ts";
import type { ProviderRegistry } from "./providers.ts";
import { CredentialStore, OAUTH_PROVIDERS, type Credential } from "./providers.ts";
import { Session, listSessions } from "./session.ts";
import { costUsd, fmtUsd } from "./pricing.ts";
import { loginDevice, loginImport, loginOauth, type LoginIO } from "./oauth.ts";
import { loadPlugins, pluginSkills } from "./plugins/loader.ts";
import type { McpClient } from "./mcp/client.ts";
import type { SkillDef } from "./skills/loader.ts";

export const SLASH_COMMANDS = [
  "/help", "/model", "/models", "/providers", "/auth", "/logout",
  "/new", "/clear", "/compact", "/sessions", "/resume",
  "/mcp", "/skills", "/plugin", "/cost", "/context", "/config",
  "/doctor", "/init", "/review", "/undo", "/tasks", "/quit",
];

export interface SlashIO {
  cfg: GoatConfig;
  setCfg(next: GoatConfig | ((c: GoatConfig) => GoatConfig)): void;
  registry: ProviderRegistry;
  session: Session;
  setSession(s: Session): void;
  saveCfg(cfg: GoatConfig): void;
  push(node: ReactNode): void;
  exit(): void;
  mcp: McpClient | null;
  skills: SkillDef[];
  /** Revert the last turn's file mutations; -1 = no toolkit, count = reverted. */
  undoTurn(): number;
  backgroundTasks(): { id: string; cmd: string; status: string; started: number }[];
  setMode(mode: "default" | "acceptEdits" | "plan" | "bypass"): void;
  runTurn(text: string): Promise<void>;
  /** Summarize old context with the model; resolves to a status line. */
  compactNow(): Promise<string>;
}

export function runSlash(line: string, io: SlashIO): boolean {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const rest = parts.slice(1);
  const arg = rest[0] ?? "";

  switch (cmd) {
    case "/quit":
    case "/exit":
      io.push(<ExitNote />);
      io.exit();
      return true;

    case "/help":
      io.push(<HelpList />);
      return true;

    case "/model": {
      if (!arg) {
        io.push(<Text>current model: <Text color="#a855f7">{io.cfg.model}</Text></Text>);
        return true;
      }
      const next = { ...io.cfg, model: arg };
      splitModel(next);
      io.setCfg(next);
      io.saveCfg(next);
      io.session.model = arg;
      io.push(<Text color="#4ade80">✓ model → {arg}</Text>);
      return true;
    }

    case "/models": {
      const p = io.registry.get(io.cfg.provider);
      if (!p) { io.push(<Text color="#f87171">✗ unknown provider</Text>); return true; }
      const models = p.models.length ? p.models : ["(no catalog models — type any model id)"];
      io.push(
        <Box flexDirection="column">
          {models.map((m) => <Text key={m}>  {p.id}/{m}</Text>)}
        </Box>,
      );
      return true;
    }

    case "/providers": {
      const rows = io.registry.listAll();
      let ready = 0;
      for (const p of rows) if (io.registry.resolveCredential(p.id)) ready++;
      io.push(
        <Box flexDirection="column">
          {rows.slice(0, 40).map((p) => {
            const has = io.registry.resolveCredential(p.id);
            return (
              <Text key={p.id}>
                <Text color={has ? "#4ade80" : "#8a8a8a"}>{has ? "✓" : " "} </Text>
                <Text>{p.id.padEnd(28)}</Text>
                <Text dimColor color="#8a8a8a"> [{fmtShort(p.format)}] {p.baseUrl.slice(0, 48)}</Text>
              </Text>
            );
          })}
          {rows.length > 40 && <Text dimColor color="#8a8a8a">  … {rows.length - 40} more</Text>}
          <Text dimColor color="#8a8a8a">  {ready}/{rows.length} configured</Text>
        </Box>,
      );
      return true;
    }

    case "/auth": {
      if (!arg) {
        io.push(<Text>usage: /auth &lt;provider&gt; --key &lt;K&gt; | --oauth</Text>);
        io.push(<Text dimColor color="#8a8a8a">  oauth: {Object.keys(OAUTH_PROVIDERS).join(", ")}</Text>);
        return true;
      }
      const pid = arg;
      if (rest.includes("--key")) {
        const idx = rest.indexOf("--key") + 1;
        const key = rest[idx];
        if (!key) { io.push(<Text color="#f87171">usage: /auth &lt;provider&gt; --key &lt;KEY&gt;</Text>); return true; }
        io.registry.store.put(pid, { kind: "api_key", apiKey: key, expiresAt: 0 });
        io.push(<Text color="#4ade80">✓ stored key for {pid}</Text>);
        return true;
      }
      if (rest.includes("--oauth")) {
        void oauthLogin(pid, io);
        return true;
      }
      io.push(<Text>usage: /auth &lt;provider&gt; --key &lt;K&gt; | --oauth</Text>);
      return true;
    }

    case "/logout": {
      if (arg && io.registry.store.remove(arg))
        io.push(<Text color="#4ade80">✓ credentials cleared for {arg}</Text>);
      else io.push(<Text>usage: /logout &lt;provider&gt;</Text>);
      return true;
    }

    case "/new": {
      io.session.save();
      const s = Session.new(process.cwd(), io.cfg.model);
      io.setSession(s);
      io.push(<Text color="#4ade80">✓ new session</Text>);
      return true;
    }

    case "/clear": {
      io.session.messages = [];
      io.session.compactedFrom = 0;
      io.push(<Text color="#4ade80">✓ context cleared</Text>);
      return true;
    }

    case "/compact": {
      const msgs = io.session.messages;
      if (msgs.length <= 12) {
        io.push(<Text dimColor color="#8a8a8a">  nothing to compact yet — context is still small</Text>);
        return true;
      }
      io.push(<Text dimColor color="#8a8a8a">  ✻ summarizing context…</Text>);
      void io.compactNow().then((status) => io.push(<Text color="#4ade80">✓ {status}</Text>));
      return true;
    }

    case "/sessions": {
      const rows = listSessions();
      io.push(
        <Box flexDirection="column">
          {rows.slice(0, 20).map((r) => (
            <Text key={r.id}>
              <Text color="#a855f7">{r.id}</Text>  {r.model.padEnd(34)} {r.title.slice(0, 52)}
            </Text>
          ))}
          {rows.length === 0 && <Text dimColor color="#8a8a8a">  (no saved sessions)</Text>}
        </Box>,
      );
      return true;
    }

    case "/resume": {
      if (!arg) { io.push(<Text>usage: /resume &lt;id&gt;  (see /sessions)</Text>); return true; }
      try {
        const s = Session.loadById(arg);
        io.setSession(s);
        io.push(<Text color="#4ade80">✓ resumed {arg}</Text>);
      } catch {
        io.push(<Text color="#f87171">✗ no such session</Text>);
      }
      return true;
    }

    case "/mcp": {
      if (!io.mcp || io.mcp.servers.size === 0) {
        io.push(<Text dimColor color="#8a8a8a">  no MCP servers connected — add to .mcp.json or config.json mcpServers</Text>);
        return true;
      }
      io.push(
        <Box flexDirection="column">
          {[...io.mcp.servers.values()].map((e) => (
            <Text key={e.name}>
              <Text color="#4ade80">✓ </Text>{e.name}
              <Text dimColor color="#8a8a8a">  {e.tools.size} tools</Text>
            </Text>
          ))}
        </Box>,
      );
      return true;
    }

    case "/skills": {
      if (!io.skills.length) {
        io.push(<Text dimColor color="#8a8a8a">  no skills found — add ~/.goatcode/skills/&lt;name&gt;/SKILL.md</Text>);
        return true;
      }
      io.push(
        <Box flexDirection="column">
          {io.skills.map((sk) => (
            <Text key={sk.name}>
              <Text color="#a855f7">/{sk.name}</Text>
              <Text dimColor color="#8a8a8a">  {sk.description}</Text>
            </Text>
          ))}
        </Box>,
      );
      return true;
    }

    case "/plugin": {
      const dirs = io.cfg.pluginDirs ?? [];
      if (!dirs.length) {
        io.push(<Text dimColor color="#8a8a8a">  no plugin dirs — list dirs under "plugins" in config.json (commands/&lt;name&gt;.md + skills/&lt;name&gt;/SKILL.md)</Text>);
        return true;
      }
      const pl = loadPlugins(dirs);
      io.push(
        <Box flexDirection="column">
          {pl.map((p) => {
            const sk = pluginSkills([p]);
            return (
              <Text key={p.dir}>
                <Text color="#4ade80">✓ </Text>{p.manifest.name ?? p.dir}
                <Text dimColor color="#8a8a8a">  {sk.length} command/skill(s): {sk.map((s) => "/" + s.name).join(" ")}</Text>
              </Text>
            );
          })}
          {pl.length < dirs.length && <Text color="#f87171">  {dirs.length - pl.length} dir(s) not found</Text>}
        </Box>,
      );
      return true;
    }

    case "/cost": {
      const u = io.session.usage;
      const est = Math.round(io.session.messages.reduce((s, m) => s + m.content.length, 0) / 4);
      io.push(<Text>  session: {io.session.messages.length} messages · {u.in} in / {u.out} out tokens{u.in ? "" : " (no usage reported yet)"} · est context ~{est} · model {io.cfg.model}</Text>);
      const cost = costUsd(io.cfg.model, u.in, u.out);
      if (cost != null)
        io.push(<Text color="#4ade80">  ≈ {fmtUsd(cost)} this session ({io.cfg.model} rates, live)</Text>);
      else
        io.push(<Text dimColor color="#8a8a8a">  no price known for {io.cfg.model} — tokens still counted above</Text>);
      return true;
    }

    case "/context": {
      const ctx = io.session.context();
      const chars = ctx.reduce((s, m) => s + m.content.length, 0);
      io.push(<Text>  context window: {ctx.length} messages · ~{Math.round(chars / 4)} tokens</Text>);
      return true;
    }

    case "/config":
      io.push(<Text>  config: {io.cfg.model} · max_tokens {io.cfg.maxTokens} · auto_approve {String(io.cfg.autoApprove)}</Text>);
      return true;

    case "/doctor": {
      io.push(<Text>  ✓ bun {Bun.version}</Text>);
      io.push(<Text>  ✓ {io.registry.listAll().length} providers loaded</Text>);
      const creds = io.registry.listAll().filter((p) => io.registry.resolveCredential(p.id)).length;
      io.push(<Text>  ✓ {creds} providers with credentials</Text>);
      io.push(<Text>  {io.mcp && io.mcp.servers.size ? `✓ ${io.mcp.servers.size} MCP servers` : "· no MCP servers"}</Text>);
      io.push(<Text>  {io.skills.length ? `✓ ${io.skills.length} skills` : "· no skills"}</Text>);
      return true;
    }

    case "/init": {
      void io.runTurn("Create a GOAT.md file documenting this codebase for future GoatCode sessions: architecture, key files, commands, conventions.");
      return true;
    }

    case "/review": {
      const target = rest.join(" ") || "the current branch changes";
      void io.runTurn(`Review ${target}. Report bugs, security issues, and simplifications — most severe first.`);
      return true;
    }

    case "/undo": {
      const r = io.undoTurn();
      if (r === null) io.push(<Text dimColor color="#8a8a8a">  nothing to undo</Text>);
      else if (r === 0) io.push(<Text color="#f87171">✗ no tool kit yet — run a turn first</Text>);
      else io.push(<Text color="#4ade80">✓ reverted {r} file mutation{r > 1 ? "s" : ""} from the last turn</Text>);
      return true;
    }

    case "/tasks": {
      const rows = io.backgroundTasks();
      if (!rows.length) { io.push(<Text dimColor color="#8a8a8a">  no background tasks</Text>); return true; }
      io.push(
        <Box flexDirection="column">
          {rows.map((t) => (
            <Text key={t.id}>
              <Text color="#a855f7">{t.id.padEnd(24)}</Text>
              <Text color={t.status === "running" ? "#facc15" : t.status.startsWith("exit") ? "#f87171" : "#4ade80"}>
                {t.status === "running" ? "● running" : "✓ done"}
              </Text>
              <Text dimColor color="#8a8a8a">  {t.cmd.slice(0, 48)}</Text>
            </Text>
          ))}
        </Box>,
      );
      return true;
    }

    default:
      io.push(<Text color="#f87171">✗ unknown command {cmd}</Text>);
      return true;
  }
}

async function oauthLogin(pid: string, io: SlashIO): Promise<void> {
  const meta = OAUTH_PROVIDERS[pid];
  if (!meta) {
    io.push(<Text color="#f87171">✗ {pid} has no OAuth flow — try: {Object.keys(OAUTH_PROVIDERS).join(", ")}</Text>);
    return;
  }
  const io2: LoginIO = {
    print: (s) => io.push(<Text>{s}</Text>),
    prompt: async (q) => {
      // Ink can't nest a second TextInput mid-render; fall back to raw stdin.
      process.stdout.write(q);
      return new Promise<string>((res) => {
        let buf = "";
        const onData = (d: Buffer) => {
          buf += d.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            process.stdin.removeListener("data", onData);
            res(buf.slice(0, nl).trim());
          }
        };
        process.stdin.setRawMode?.(false);
        process.stdin.on("data", onData);
      });
    },
  };
  try {
    let cred: Credential;
    const flow = meta.flow ?? "browser";
    if (flow === "device") cred = await loginDevice(pid, io2);
    else if (flow === "import") cred = await loginImport(pid, io2);
    else cred = await loginOauth(pid, io2);
    io.registry.store.put(pid, cred);
    io.push(<Text color="#4ade80">✓ logged in to {pid}</Text>);
    io.push(<Text dimColor color="#8a8a8a">  try: /model {pid}/{meta.model_prefix}-…</Text>);
  } catch (e: any) {
    io.push(<Text color="#f87171">✗ login failed: {e?.message ?? String(e)}</Text>);
  }
}

function fmtShort(f: string): string {
  return { openai: "oai", claude: "ant", "openai-responses": "rsp", gemini: "gem" }[f] ?? f;
}

// ---------- tiny presentational components ----------
import { Box, Text } from "ink";

function ExitNote() {
  return <Text dimColor color="#8a8a8a">bye</Text>;
}

function HelpList() {
  return (
    <Box flexDirection="column">
      {SLASH_COMMANDS.map((c) => (
        <Text key={c}><Text color="#a855f7">{c.padEnd(14)}</Text><Text dimColor color="#8a8a8a"> {descOf(c)}</Text></Text>
      ))}
    </Box>
  );
}

export const COMMAND_DESC: Record<string, string> = {
  "/help": "show help", "/model": "switch model", "/models": "list models",
  "/providers": "list providers", "/auth": "add credentials", "/logout": "clear credentials",
  "/new": "new session", "/clear": "clear context", "/compact": "fold old context into a digest",
  "/sessions": "list sessions", "/resume": "resume a session", "/mcp": "manage MCP servers",
  "/skills": "list skills", "/plugin": "manage plugins", "/cost": "session cost",
  "/context": "context usage", "/config": "open config", "/doctor": "diagnose install",
  "/init": "create GOAT.md", "/review": "review a PR", "/undo": "revert last turn's file changes",
  "/tasks": "list background bash tasks", "/quit": "exit",
};

function descOf(cmd: string): string {
  return COMMAND_DESC[cmd] ?? "";
}
