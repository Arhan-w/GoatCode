/**
 * GoatCode v2 — Claude Code-style Ink/React REPL.
 *
 *   ❯ prompt box with rounded border + mode · model · path footer
 *   thinking spinner (verb + elapsed + tokens + "esc to interrupt")
 *   ● Tool(args)  /  ⎿ result lines
 *   numbered permission dialog (Yes / Yes-all-session / No)
 *   slash-command completion with descriptions
 *   Shift+Tab / Ctrl+O mode cycle · Ctrl+C interrupt · ↑↓ history
 */
import { Box, Static, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Agent, type AgentEvent } from "./agent.ts";
import { COMMAND_DESC, SLASH_COMMANDS, runSlash, type SlashIO } from "./commands.tsx";
import { appDir, loadConfig, saveConfig, splitModel, type GoatConfig } from "./config.ts";
import { ProviderRegistry } from "./providers.ts";
import { resolveSmall, resolveFallbacks, ResolveError, resolve } from "./runtime.ts";
import { Session } from "./session.ts";
import { loadSkills, loadSkillBody, type SkillDef } from "./skills/loader.ts";
import { loadPlugins, pluginSkills } from "./plugins/loader.ts";
import { buildExtraSystem, loadOutputStyle } from "./context.ts";
import { loadMcpFromConfig, type McpClient } from "./mcp/client.ts";
import { ToolKit, IMAGE_TYPES, MAX_IMAGE_BYTES, sniffImage } from "./tools.ts";
import { clipboardImage } from "./computer.ts";
import { runStatusLine, statusInput } from "./statusline.ts";
import { cachedUpdateHint, refreshUpdateHint } from "./update.ts";
import { log } from "./logger.ts";
import { contentChars, estimateTokens } from "./llm.ts";
import type { ContentPart } from "./llm.ts";
import type { Todo } from "./tools.ts";

// ---------- theme (goat violet) ----------
export const ACCENT = "#a855f7";
const DIM = "#8a8a8a";
const GREEN = "#4ade80";
const RED = "#f87171";
const BORDER = "#555555";

const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const VERBS = [
  "Accomplishing", "Actioning", "Architecting", "Baking", "Booping",
  "Calculating", "Cerebrating", "Channelling", "Choreographing", "Coalescing",
  "Computing", "Concocting", "Considering", "Contemplating", "Cooking",
  "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating",
  "Determining", "Divining", "Doing", "Effecting", "Elucidating",
  "Envisioning", "Finagling", "Forging", "Formulating", "Generating",
  "Hatching", "Herding", "Ideating", "Inferring", "Manifesting",
  "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating",
  "Pondering", "Processing", "Puttering", "Reasoning", "Reticulating",
  "Ruminating", "Schlepping", "Simmering", "Spinning", "Synthesizing",
  "Thinking", "Transmuting", "Vibing", "Working",
];

function pickVerb(): string {
  return VERBS[Math.floor(Math.random() * VERBS.length)];
}
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function shortPath(p: string): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * @file/@dir/@image expansion lives in refs.ts (shared with `goat web`).
 * These wrappers keep the TUI signature (push renders React nodes).
 */
import { expandFileRefs as _ef, buildUserContent as _bu } from "./refs.ts";
export const expandFileRefs = _ef;
export const buildUserContent = _bu;

type Mode = "default" | "acceptEdits" | "plan" | "bypass";
const MODE_LABEL: Record<Mode, string> = {
  default: "ask before edits",
  acceptEdits: "⏵⏵ accept edits on",
  plan: "⏸ plan mode on",
  bypass: "⏩ bypass permissions on",
};
const MODE_ORDER: Mode[] = ["default", "acceptEdits", "plan", "bypass"];

interface PermRequest {
  tool: string;
  args: Record<string, unknown>;
  resolve: (ok: boolean) => void;
}

/** Visible terminal width in cells (CJK double-width counted as 2). */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}
const cols = () => Math.max(40, process.stdout.columns ?? 96);
/**
 * Rows the streaming region may occupy. The rest of the live frame is fixed:
 * spinner+thinkline (2), tool/plan context (a few), input box (3), status (2),
 * margins (2) — plus a permission dialog (~7) that can appear while a turn
 * runs. Overshooting stdout.rows makes the terminal scroll, which breaks Ink's
 * erase-and-repaint and ghosts the borders. 15 is the honest reservation.
 */
const liveBudget = () => Math.max(2, (process.stdout.rows ?? 24) - 15);
/** Keep the trailing lines of `text` that fit in `budget` wrapped rows of `width`. */
function tailWithin(text: string, budget: number, width: number): string {
  const lines = text.split("\n");
  let rows = 0, start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    rows += Math.max(1, Math.ceil(textWidth(lines[i]) / (width - 2)));
    if (rows > budget) break;
    start = i;
  }
  return lines.slice(start).join("\n");
}

/** Renders the TUI and RESOLVES ONLY WHEN THE APP EXITS. Callers must await. */
export async function run(cfg: GoatConfig = loadConfig(), resume?: string): Promise<void> {
  // Claude-style boot: wipe screen + scrollback first so the session owns a
  // clean viewport instead of trailing under shell history.
  process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
  const { waitUntilExit } = render(
    <App initialCfg={cfg} resume={resume} />,
    { stdin: process.stdin, stdout: process.stdout, exitOnCtrlC: false },
  );
  await waitUntilExit();
}

function App({ initialCfg, resume }: { initialCfg: GoatConfig; resume?: string }) {
  const { exit } = useApp();
  const [cfg, setCfg] = useState(initialCfg);
  log("boot", `goat ${cfg.model} cwd=${resume ?? process.cwd()}`);
  const mcpRef = useRef<McpClient | null>(null);

  // Production: shutdown MCP cleanly and save on exit, SIGTERM, SIGHUP
  useEffect(() => {
    const cleanup = async () => {
      try { await mcpRef.current?.shutdown(); } catch { /* */ }
      try { sessionRef.current.save(); } catch { /* */ }
    };
    const onSig = () => { cleanup().then(() => exit()); };
    process.on("SIGTERM", onSig);
    process.on("SIGHUP", onSig);
    return () => {
      process.off("SIGTERM", onSig);
      process.off("SIGHUP", onSig);
    };
  }, [exit]);
  const registryRef = useRef(new ProviderRegistry(initialCfg.endpoints));
  const [session, setSession] = useState<Session>(() => {
    if (resume) {
      try { return Session.loadById(resume); } catch { /* fall through */ }
    }
    return Session.new(process.cwd(), initialCfg.model);
  });
  const [mcp, setMcp] = useState<McpClient | null>(null);
  const [mcpErrors, setMcpErrors] = useState<string[]>([]);
  mcpRef.current = mcp;
  const [skills, setSkills] = useState<SkillDef[]>([]);

  const [mode, setMode] = useState<Mode>(initialCfg.autoApprove ? "bypass" : "default");
  const [input, setInput] = useState("");
  const [authBanner, setAuthBanner] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [lines, setLines] = useState<ReactNode[]>([]);
  const [stream, setStream] = useState("");
  const [thinking, setThinking] = useState(false);
  const [verb, setVerb] = useState("Thinking");
  const [elapsed, setElapsed] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [perm, setPerm] = useState<PermRequest | null>(null);
  const [permSel, setPermSel] = useState(0);
  const [completions, setCompletions] = useState<string[]>([]);
  const [compSel, setCompSel] = useState(0);
  const [thinkLine, setThinkLine] = useState("");
  const [pasted, setPasted] = useState<string | null>(null); // ctrl+V image path
  const [todos, setTodos] = useState<Todo[]>([]);
  const [statusLines, setStatusLines] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const queuedRef = useRef<string[]>([]);
  const submitRef = useRef<((raw: string) => void) | null>(null);
  const lastCtrlC = useRef(0);
  const lineKey = useRef(0);
  const toolsRef = useRef<ToolKit | null>(null);
  const notifiedBg = useRef<Set<string>>(new Set());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const push = useCallback((node: ReactNode) => {
    setLines((prev) => [...prev, <Box key={lineKey.current++}>{node}</Box>]);
  }, []);

  // boot: welcome + async init of mcp/skills + a live auth probe so a
  // misconfigured install shows a banner instead of a silent dead shell
  useEffect(() => {
    push(<Welcome cfg={cfgRef.current} cwd={sessionRef.current.cwd} />);
    (async () => {
      try {
        const { resolve, AuthRequired, UnknownProvider } = await import("./runtime.ts");
        await resolve(cfgRef.current, registryRef.current);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("needs credentials")) {
          setAuthBanner(msg);
        } else {
          push(<Text color="#f87171">{msg}</Text>);
        }
      }
      try {
        const m = await loadMcpFromConfig({ mcpServers: cfgRef.current.mcpServers });
        m.onError = (msg) => { setMcpErrors((prev) => [...prev, msg]); log("mcp", msg); };
        setMcp(m);
        if (m.servers.size)
          push(<Text dimColor color={DIM}>  ⚡ {m.servers.size} MCP server(s) connected</Text>);
      } catch { /* mcp optional */ }
      const dirs = [
        join(appDir(), "skills"),
        join(process.cwd(), "skills"),
        join(process.cwd(), ".claude", "skills"),
      ];
      const pl = loadPlugins(cfgRef.current.pluginDirs.map((d) => resolvePath(process.cwd(), d)));
      const native = loadSkills(...dirs);
      const fromPlugins = pluginSkills(pl);
      if (pl.length)
        push(<Text dimColor color={DIM}>  🔌 {pl.length} plugin(s) · {fromPlugins.length} command/skill(s)</Text>);
      // native wins on name collision; plugins extend the palette
      const names = new Set(native.map((s) => s.name));
      setSkills([...native, ...fromPlugins.filter((s) => !names.has(s.name))]);
      // update hint: cached check (max 1 API call / 6h), never blocks boot
      const hint = cachedUpdateHint();
      if (hint) push(<Text dimColor color={DIM}>  ↑ GoatCode {hint.latest} available — run: goat self-update</Text>);
      else refreshUpdateHint();
    })();
  }, [push]);

  // spinner clock
  useEffect(() => {
    if (!thinking) return;
    const t0 = Date.now();
    setVerb(pickVerb());
    const id = setInterval(() => setElapsed(Date.now() - t0), 100);
    return () => clearInterval(id);
  }, [thinking]);

  const askPermission = useCallback((tool: string, args: Record<string, unknown>): Promise<boolean> => {
    return new Promise((res) => {
      setPerm({ tool, args, resolve: res });
      setPermSel(0);
    });
  }, []);

  const buildAgent = useCallback(async (): Promise<Agent | null> => {
    try {
      const r = await resolve(cfgRef.current, registryRef.current);
      const smallClient = await resolveSmall(cfgRef.current, registryRef.current);
      const fallbacks = await resolveFallbacks(cfgRef.current, registryRef.current, sessionRef.current.model);
      const m = modeRef.current;
      // one ToolKit per session so the undo stack + bg tasks survive turns
      if (!toolsRef.current || toolsRef.current.root !== sessionRef.current.cwd)
        toolsRef.current = new ToolKit(sessionRef.current.cwd);
      const tools = toolsRef.current;
      // plan mode: read-only — mutating tools are denied up front
      tools.readonly = m === "plan";
      tools.autoApprove = m === "bypass";
      tools.rules = cfgRef.current.permissions;
      tools.hooks = cfgRef.current.hooks;
      tools.sessionId = sessionRef.current.id;
      // acceptEdits auto-approves file edits, still asks for bash (Claude semantics)
      tools.permission = (t, a) =>
        m === "acceptEdits" && (t === "write" || t === "edit") ? true : askPermission(t, a);
      if (mcp)
        for (const spec of mcp.specs())
          tools.registerExternal({ spec, run: (args) => mcp.dispatch(spec.name, args) });
      return new Agent({
        client: r.client, smallClient: smallClient ?? undefined,
        session: sessionRef.current, tools,
        maxTokens: cfgRef.current.maxTokens, temperature: cfgRef.current.temperature,
        maxSteps: cfgRef.current.maxSteps,
        fallbacks,
        extraSystem: [buildExtraSystem(skills, sessionRef.current.cwd),
          loadOutputStyle(cfgRef.current.outputStyle)].filter(Boolean).join("\n\n"),
      });
    } catch (e) {
      const msg = e instanceof ResolveError ? e.message : String((e as Error).message);
      log("resolve", msg);
      if (e instanceof ResolveError) push(<Text color={RED}>{msg}</Text>);
      else push(<Text color={RED}>{msg}</Text>);
      return null;
    }
  }, [askPermission, mcp, push]);

  const runTurn = useCallback(async (text: string | ContentPart[]) => {
    const agent = await buildAgent();
    if (!agent) return;
    agent.tools.beginCheckpoint(); // /undo reverts everything from here on
    setThinking(true);
    setStream("");
    setTokens(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let acc = "";
    let thinkAcc = "";
    const flush = () => {
      if (acc.trim()) push(<MdText text={acc.trimEnd()} />);
      acc = "";
      setStream("");
    };
    try {
      for await (const ev of agent.runTurn(text, ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        switch (ev.kind) {
          case "text": {
            acc += ev.text;
            // The live frame must never exceed the viewport: scrolling breaks
            // Ink's clear/redraw and ghosts the input box (duplicate borders).
            // Anything past the budget scrolls into history (Static) as settled
            // lines — same as Claude Code streaming into scrollback.
            const budget = liveBudget();
            const kept = tailWithin(acc, budget, cols());
            if (kept !== acc) {
              const done = acc.slice(0, acc.length - kept.length).trimEnd();
              if (done.trim()) push(<MdText text={done} />);
              acc = kept;
            }
            setStream(acc);
            break;
          }
          case "thinking":
            thinkAcc += ev.text;
            setThinkLine(thinkAcc.split("\n").slice(-1)[0].slice(0, 120));
            break;
          case "tool_start": {
            flush();
            const a = ev.args as Record<string, unknown>;
            const brief = String(a.path ?? a.command ?? a.pattern ?? JSON.stringify(a)).slice(0, 120);
            push(
              <Text>
                <Text color={ACCENT}>●</Text> <Text bold>{ev.tool}</Text>{" "}
                <Text dimColor color={DIM}>{brief}</Text>
              </Text>,
            );
            break;
          }
          case "tool_end": {
            const first = (ev.result || "").split("\n")[0]?.slice(0, 160) ?? "";
            push(
              <Text>
                <Text color={ev.ok ? GREEN : RED}>  ⎿ {ev.ok ? "completed" : "failed"}</Text>
                <Text dimColor color={DIM}>  {first}</Text>
              </Text>,
            );
            break;
          }
          case "usage": {
            const mm = ev.text.match(/(\d+)\+(\d+)/);
            if (mm) setTokens(Number(mm[2]));
            break;
          }
          case "todo":
            setTodos(ev.todos);
            break;
          case "fallback":
            flush();
            // stick the switch for later turns AND across restarts
            setCfg((c) => {
              const n = { ...c, model: ev.to };
              splitModel(n);
              saveConfig(n);
              return n;
            });
            push(
              <Text>
                <Text color="#fbbf24">⇢ switched provider</Text>
                <Text dimColor color={DIM}>  {ev.from} → {ev.to} — {ev.reason}</Text>
              </Text>,
            );
            log("agent", `fallback ${ev.from} -> ${ev.to}: ${ev.reason}`);
            break;
          case "retry":
            flush();
            push(
              <Text>
                <Text color="#facc15">↻ retrying</Text>
                <Text dimColor color={DIM}>  attempt {ev.attempt + 1} in {(ev.waitMs / 1000).toFixed(1)}s — {ev.reason}</Text>
              </Text>,
            );
            break;
          case "error":
            flush();
            log("agent", ev.text);
            push(<Text color={RED}>✗ {ev.text}</Text>);
            break;
        }
      }
    } catch (e: any) {
      push(<Text color={RED}>✗ {e?.message ?? String(e)}</Text>);
    } finally {
      flush();
      setThinking(false);
      setThinkLine("");
      abortRef.current = null;
      setAuthBanner(null); // a successful turn means credentials are fine
      sessionRef.current.save();
      // drain one queued mid-turn message (⤷ steering); recursion through
      // submit->runTurn handles any that arrive during its turn
      if (queuedRef.current.length && !ctrl.signal.aborted) {
        const q = queuedRef.current.shift()!;
        setTimeout(() => submitRef.current?.(q), 50);
      }
      // notify finished background tasks (Claude Code does this between turns)
      for (const t of agent.tools.backgroundTasks()) {
        if (t.status !== "running" && !notifiedBg.current.has(t.id)) {
          notifiedBg.current.add(t.id);
          push(
            <Text>
              <Text color={ACCENT}>⚡ </Text>
              <Text dimColor color={DIM}>task {t.id} finished: {t.cmd.slice(0, 48)} — {t.status.split("\n")[0].slice(0, 80)}</Text>
            </Text>,
          );
        }
      }
    }
  }, [buildAgent, push]);

  const submit = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text) return;
    // Mid-turn steering (Claude Code / Codex parity): typing while the agent
    // works queues the message for immediate follow-up instead of dropping it.
    if (thinking) {
      setInput("");
      setCompletions([]);
      queuedRef.current.push(text);
      push(<Text dimColor color={DIM}>  ⤷ queued for next turn ({queuedRef.current.length})</Text>);
      return;
    }
    // Enter with the completion menu open accepts, like Claude Code
    if (completions.length > 0 && compSel < completions.length && text.startsWith("/")) {
      setInput(completions[compSel] + " ");
      setCompletions([]);
      return;
    }
    setHistory((h) => [...h, text]);
    setHistIdx(-1);
    setInput("");
    setCompletions([]);
    push(<Text><Text color={ACCENT} bold>❯ </Text><Text>{text}</Text></Text>);

    // !bash mode — run a shell command directly, output to scrollback
    if (text.startsWith("!")) {
      const cmd = text.slice(1).trim();
      (async () => {
        if (!toolsRef.current || toolsRef.current.root !== sessionRef.current.cwd)
          toolsRef.current = new ToolKit(sessionRef.current.cwd);
        const tk = toolsRef.current;
        const wasAuto = tk.autoApprove, hadPerm = tk.permission;
        tk.autoApprove = true; tk.permission = null;
        const r = await tk.dispatch("bash", { command: cmd });
        tk.autoApprove = wasAuto; tk.permission = hadPerm;
        push(<Text color={r.ok ? GREEN : RED}>{r.output.slice(0, 4000)}</Text>);
      })();
      return;
    }
    // # memory — append a line to project GOAT.md
    if (text.startsWith("#")) {
      const note = text.slice(1).trim();
      if (note) {
        try {
          const memPath = join(sessionRef.current.cwd, "GOAT.md");
          if (!existsSync(memPath)) appendFileSync(memPath, "# Project memory\n\n");
          appendFileSync(memPath, `- ${note}\n`);
          push(<Text color={GREEN}>✓ saved to GOAT.md</Text>);
        } catch (e: any) {
          push(<Text color={RED}>✗ {e?.message}</Text>);
        }
      }
      return;
    }

    // @file references — text refs inline as fenced content; image refs attach
    // base64 parts the model can see (anthropic/openai/gemini/responses)
    let expanded = buildUserContent(text, sessionRef.current.cwd, (m) => push(<Text color={RED}>  ⚠ {m}</Text>));
    // ctrl+V image: attach as a base64 part (and give a bare paste a prompt)
    if (pasted) {
      try {
        const buf = readFileSync(pasted);
        const mediaType = sniffImage(buf);
        if (mediaType) {
          const imgPart = { type: "image", data: buf.toString("base64"), mediaType } as ContentPart;
          const intro = typeof expanded === "string"
            ? (text ? expanded : "What do you see in this image?")
            : expanded;
          expanded = Array.isArray(intro)
            ? [...intro, imgPart]
            : [{ type: "text", text: intro }, imgPart];
        }
      } catch { /* fall back to text-only */ }
      try { unlinkSync(pasted); } catch { /* */ }
      setPasted(null);
    }

    // /skill-name invocation: load the body and run it as a prompt
    if (text.startsWith("/") && !SLASH_COMMANDS.some((c) => text === c || text.startsWith(c + " "))) {
      const name = text.slice(1).split(" ")[0];
      const rest = text.slice(1 + name.length).trim();
      const sk = skills.find((s) => s.name === name);
      if (sk) {
        const body = loadSkillBody(sk).replace(/\$ARGUMENTS/g, rest).replace(/\$(\d)/g, (_, i) => rest.split(/\s+/)[Number(i) - 1] ?? "");
        void runTurn(`[skill: /${sk.name}]\n${body}\n\n${rest || "Execute this skill on the current project."}`);
        return;
      }
    }
    if (text.startsWith("/")) {
      const io: SlashIO = {
        cfg: cfgRef.current, setCfg, registry: registryRef.current,
        session: sessionRef.current,
        setSession: (s) => { sessionRef.current = s; setSession(s); },
        saveCfg: saveConfig, push, exit, mcp, skills,
        clearAuthBanner: () => setAuthBanner(null),
        undoTurn: () => toolsRef.current ? toolsRef.current.undoCheckpoint() : null,
        backgroundTasks: () => toolsRef.current?.backgroundTasks() ?? [],
        setMode: (m) => { setMode(m); setCfg((c) => ({ ...c, autoApprove: m === "bypass" })); },
        reloadPlugins: () => {
          const pl = loadPlugins(cfgRef.current.pluginDirs.map((d) => resolvePath(process.cwd(), d)));
          const fromPlugins = pluginSkills(pl);
          const native = loadSkills(
            join(appDir(), "skills"),
            join(process.cwd(), "skills"),
            join(process.cwd(), ".claude", "skills"),
          );
          const names = new Set(native.map((s) => s.name));
          setSkills([...native, ...fromPlugins.filter((s) => !names.has(s.name))]);
          return native.length + fromPlugins.length;
        },
        runTurn,
        compactNow: async () => {
          const agent = await buildAgent();
          if (!agent) return "compact failed — no usable client";
          const r = await agent.compactNow();
          if (r.folded === 0) return "already compacted — nothing older to fold";
          return `summarized ${r.folded} older messages${r.model ? " with the model" : " (deterministic digest fallback)"} — context rebuilt`;
        },
      };
      runSlash(text, io);
      return;
    }
    void runTurn(expanded);
  }, [thinking, push, mcp, skills, exit, runTurn, completions, compSel, pasted]);
  submitRef.current = submit;

  const cycleMode = useCallback(() => {
    setMode((m) => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length];
      setCfg((c) => ({ ...c, autoApprove: next === "bypass" }));
      return next;
    });
  }, []);

  // keyboard handling
  useInput((ch, k) => {
    if (perm) {
      if (k.upArrow) setPermSel((s) => (s + 2) % 3);
      else if (k.downArrow) setPermSel((s) => (s + 1) % 3);
      else if (k.return) {
        if (permSel === 1) setMode("acceptEdits"); // "yes, allow all this session"
        perm.resolve(permSel < 2);
        setPerm(null);
      } else if (k.escape || ch === "n") {
        perm.resolve(false);
        setPerm(null);
      }
      return;
    }
    if (k.ctrl && ch === "c") {
      if (thinking) { abortRef.current?.abort(); push(<Text color={RED}>⚠ interrupted</Text>); return; }
      // Claude Code semantics: one Ctrl+C warns, a second within 2s exits
      const now = Date.now();
      if (now - lastCtrlC.current < 2000) { exit(); return; }
      lastCtrlC.current = now;
      push(<Text dimColor color={DIM}>  press ctrl+c again to exit · or /quit · session auto-saved</Text>);
      return;
    }
    if (k.ctrl && ch === "d") { exit(); return; }
    if (k.ctrl && ch === "k") { setInput(""); return; } // clear current input line
    if (k.ctrl && ch === "v") {
      // clipboard image attach (Claude-Code-style); text pastes are handled by
      // the terminal itself and arrive as ordinary input
      void clipboardImage().then((p) => {
        if (!p) { push(<Text dimColor color={DIM}>  clipboard has no image</Text>); return; }
        try {
          const size = statSync(p).size;
          if (size > MAX_IMAGE_BYTES) { push(<Text color={RED}>  ⚠ pasted image too large ({size} bytes)</Text>); return; }
          if (!sniffImage(readFileSync(p))) { push(<Text color={RED}>  ⚠ clipboard image is not a png/jpeg/gif/webp</Text>); return; }
          setPasted(p);
          push(<Text color={ACCENT}>  ⧈ image attached from clipboard — type your question and hit Enter</Text>);
        } catch (e: any) {
          push(<Text color={RED}>  paste failed: {e?.message ?? e}</Text>);
        }
      });
      return;
    }
    if (k.ctrl && ch === "t") {
      const rows = toolsRef.current?.backgroundTasks() ?? [];
      if (!rows.length) push(<Text dimColor color={DIM}>  no background tasks</Text>);
      else for (const t of rows)
        push(
          <Text>
            <Text color={ACCENT}>{t.id.padEnd(24)}</Text>
            <Text color={t.status === "running" ? "#facc15" : GREEN}>{t.status === "running" ? "● running" : "✓ done"}</Text>
            <Text dimColor color={DIM}>  {t.cmd.slice(0, 48)}</Text>
          </Text>,
        );
      return;
    }
    if (k.ctrl && ch === "o") { cycleMode(); return; }
    // Shift+Tab arrives as an empty char with shift+tab flags (verified via
    // Ink's parse-keypress); older/odd terminals send ESC [ Z as raw text.
    if ((k.shift && k.tab) || ch === "\x1b[Z") { cycleMode(); return; }
    if (k.ctrl && ch === "l") {
      // Static output is already on the terminal — wipe screen + scrollback
      // then reset state so the live region repaints from a clean slate.
      process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
      setLines([]); setStream(""); return;
    }
    if (k.ctrl && ch === "r") {
      // reverse history search: cycle inserted prompt from history
      if (history.length) {
        const q = input.trim();
        const idx = history.map((h, i) => ({ h, i })).reverse()
          .find(({ h }) => !q || h.toLowerCase().includes(q.toLowerCase()));
        if (idx) setInput(history[idx.i]);
      }
      return;
    }
    if (k.meta && ch === "m") { cycleMode(); return; } // Windows fallback for Shift+Tab
    if (k.escape && thinking) { abortRef.current?.abort(); return; }
    if (k.upArrow) {
      if (completions.length) setCompSel((s) => Math.max(0, s - 1));
      else if (history.length) {
        const ni = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(ni);
        setInput(history[ni]);
      }
      return;
    }
    if (k.downArrow) {
      if (completions.length) setCompSel((s) => Math.min(completions.length - 1, s + 1));
      else if (histIdx >= 0) {
        const ni = histIdx + 1;
        if (ni >= history.length) { setHistIdx(-1); setInput(""); }
        else { setHistIdx(ni); setInput(history[ni]); }
      }
      return;
    }
    if (k.tab && completions.length) {
      setInput(completions[compSel] + " ");
      setCompletions([]);
    }
  });

  // live completion as the user types a slash command
  useEffect(() => {
    if (input.startsWith("/") && !input.includes(" ")) {
      setCompletions(SLASH_COMMANDS.filter((c) => c.startsWith(input)).slice(0, 8));
      setCompSel(0);
    } else setCompletions([]);
  }, [input]);

  // custom statusline: refresh on mode/session changes, during thinking, and
  // every 12s otherwise (5s command timeout — cheap enough)
  useEffect(() => {
    const cmd = cfg.statusLine?.command;
    if (!cmd) { setStatusLines([]); return; }
    let cancelled = false;
    const tick = async () => {
      const used = sessionRef.current.messages.reduce((s, m) => s + contentChars(m.content), 0);
      const lines = await runStatusLine(cmd, statusInput(sessionRef.current, cfg.model, cfg.outputStyle, used, thinking));
      if (!cancelled && lines) setStatusLines(lines);
    };
    void tick();
    const id = setInterval(() => void tick(), thinking ? 3000 : 12_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [cfg.statusLine?.command, thinking, session, mode, cfg.model, cfg.outputStyle]);

  const frame = SPINNER_FRAMES[Math.floor(elapsed / 120) % SPINNER_FRAMES.length];

  return (
    <Box flexDirection="column" width="100%">
      <Static items={lines}>
        {(item) => item}
      </Static>

      {authBanner && (
        <Box flexDirection="column" borderStyle="round" borderColor="#facc15" paddingX={1} marginY={1}>
          <Text color="#facc15" bold>⚠  GoatCode is installed but not ready yet</Text>
          <Text dimColor color={DIM}>{authBanner}</Text>
          <Text dimColor color={DIM}>  then type a message and hit Enter, or run /auth to fix it now</Text>
        </Box>
      )}
      {thinking && (
        <Box flexDirection="column">
          <Text>
            <Text color={ACCENT}>{frame} {verb}…</Text>
            <Text dimColor color={DIM}>
              {"  "}{fmtElapsed(elapsed)}{tokens ? ` · ${tokens} tok` : ""}
              {"  "}esc to interrupt
            </Text>
          </Text>
          {thinkLine && !stream ? <Text dimColor color={DIM}>  {thinkLine}</Text> : null}
          {stream ? <MdText text={stream} /> : null}
        </Box>
      )}

      {perm && <PermDialog req={perm} sel={permSel} />}

      {todos.length > 0 && <PlanPanel todos={todos} />}

      {mcpErrors.length > 0 && (
        <Box flexDirection="column" paddingLeft={1} marginBottom={0}>
          {mcpErrors.map((e, i) => (
            <Text key={i} color="#facc15">  ⚠ {e}</Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={thinking ? BORDER : ACCENT} paddingLeft={1}>
          <Text color={ACCENT} bold>❯ </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            placeholder="help me build…  (/ for commands)"
          />
        </Box>
        {completions.length > 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            {completions.map((c, i) => (
              <Text key={c}>
                <Text color={i === compSel ? ACCENT : undefined} inverse={i === compSel}>{c}</Text>
                <Text dimColor color={DIM}>  {COMMAND_DESC[c]}</Text>
              </Text>
            ))}
          </Box>
        )}
      </Box>

      {cfg.statusLine?.command && statusLines.length ? (
        <Box flexDirection="column" paddingLeft={1}>
          {statusLines.map((l, i) => <Text key={i} dimColor color={DIM}>{l}</Text>)}
        </Box>
      ) : (
        <Box paddingLeft={1}>
          <Text dimColor color={DIM}>
            <Text color={mode === "default" ? DIM : ACCENT}>{MODE_LABEL[mode]}</Text>
            {"  (shift+tab to cycle)  ·  "}{cfg.model}
            {"  ·  "}{shortPath(session.cwd)}
            {"  ·  "}
            {mcp?.servers.size ? `${mcp.servers.size} mcp · ` : ""}
            {skills.length ? `${skills.length} skills · ` : ""}
            <Text color={ACCENT}>/help</Text>
            <Text dimColor color={DIM}> · ctrl+t tasks · /undo</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------- sub-components ----------

function PlanPanel({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={0}>
      <Text dimColor color={DIM}>  Plan {done}/{todos.length}</Text>
      {todos.slice(-4).map((t, i) => (
        <Text key={`${t.content}-${i}`}>
          <Text color={t.status === "completed" ? GREEN : t.status === "in_progress" ? ACCENT : DIM}>
            {"  "}{t.status === "completed" ? "✔" : t.status === "in_progress" ? "▸" : "○"}{" "}
          </Text>
          <Text color={t.status === "completed" ? DIM : undefined} strikethrough={t.status === "completed"}>
            {t.status === "in_progress" ? t.activeForm : t.content}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function Welcome({ cfg, cwd }: { cfg: GoatConfig; cwd: string }) {
  const goat = [
    "███            ███",
    "███▄          ▄███",
    "▀███▄ ▄▄▄▄▄▄ ▄███▀",
    "  ▀████▀▀▀▀████▀",
    " ▄▄████▄  ▄████▄▄",
    "   ██▀▀▀  ▀▀▀██",
    "   ▀██▄ ▀▀ ▄██▀",
    "     ▀██████▀",
    "        ▄▀▄",
  ];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={ACCENT}>{goat.map((l, i) => l + "\n").join("")}</Text>
        <Text color={ACCENT} bold>  GoatCode</Text>
        <Text dimColor color={DIM}>  v2.1  ·  every provider, one terminal</Text>
      </Text>
      <Text dimColor color={DIM}>  model {cfg.model}</Text>
      <Text dimColor color={DIM}>  path  {shortPath(cwd)}</Text>
      <Text dimColor color={DIM}>  tips  /help · /providers · shift+tab cycles mode</Text>
    </Box>
  );
}

function PermDialog({ req, sel }: { req: PermRequest; sel: number }) {
  const a = req.args as Record<string, unknown>;
  const detail = String(a.command ?? a.path ?? JSON.stringify(a)).slice(0, 200);
  const opts = [
    "Yes",
    "Yes, and allow all edits this session",
    "No, and tell GoatCode what to do differently",
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginY={1}>
      <Text bold>● {req.tool} — allow?</Text>
      <Text dimColor color={DIM}>  {detail}</Text>
      <Text> </Text>
      <Text>Do you want to proceed?</Text>
      {opts.map((o, i) => (
        <Text key={i}>
          <Text color={i === sel ? ACCENT : DIM}>{i === sel ? "❯ " : "  "}</Text>
          <Text bold={i === sel}>{i + 1}. {o}</Text>
        </Text>
      ))}
      <Text dimColor color={DIM}>  esc to cancel · ↑↓ to move</Text>
    </Box>
  );
}

/** Minimal markdown: bold, inline code, lists — rendered with Ink Text. */
function MdText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  text.split("\n").forEach((ln, i) => {
    const parts: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m: RegExpExecArray | null, key = 0;
    while ((m = re.exec(ln))) {
      if (m.index > last) parts.push(<Text key={key++}>{ln.slice(last, m.index)}</Text>);
      const tok = m[0];
      if (tok.startsWith("**")) parts.push(<Text key={key++} bold>{tok.slice(2, -2)}</Text>);
      else parts.push(<Text key={key++} color={ACCENT}>{tok.slice(1, -1)}</Text>);
      last = m.index + tok.length;
    }
    if (last < ln.length) parts.push(<Text key={key++}>{ln.slice(last)}</Text>);
    out.push(<Box key={i} minHeight={1}><Text>{parts}</Text></Box>);
  });
  return <Box flexDirection="column">{out}</Box>;
}
