/**
 * Goated-Flash-Free: the inbuilt free coding model.
 *
 * The Python proxy that bridges Gemini Web to an OpenAI-compatible local API
 * is embedded in the GoatCode binary (src/vendor/flashServer.ts, generated
 * from src/vendor/gemini-web2api/gemini_web2api.py). On first use GoatCode
 * writes it into ~/.goatcode/vendor/, launches it with a detected Python 3,
 * and talks to it over loopback. No API key, no signup, free.
 *
 * Auto-engage: when the user has no provider credentials at all, GoatCode
 * boots on goated-flash/gemini-3.5-flash. /model flash switches to it any
 * time; /model <provider>/<model> switches away.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appDir } from "./config.ts";
import { FLASH_SERVER_PY } from "./vendor/flashServer.ts";
import { makeClient } from "./llm.ts";
import type { ChatClient, StreamEvent, StreamOpts, ToolSpec, Message } from "./llm.ts";

export const GOATED_FLASH_ID = "goated-flash";
export const GOATED_FLASH_LABEL = "Goated-Flash-Free";
export const GEMINI_FREE_MODEL = "gemini-3.5-flash";
export const GEMINI_FREE_MODELS = [
  "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash",
  "gemini-3.5-flash-thinking", "gemini-flash-lite",
];

/** Tool-call convention the proxy understands (parsed out of the reply). */
export const FLASH_TOOL_INSTRUCTION =
  "You can call tools. To call one, reply with ONLY a fenced block:\n" +
  "```tool_call\n{\"name\": \"<tool>\", \"arguments\": { ... }}\n```\n" +
  "Use short JSON (no comments). After the tool result arrives you may continue.";

/** Strip the tool_call fences from streamed assistant text for display. */
export function flashToolCallsFromText(text: string): { clean: string; calls: { name: string; arguments: Record<string, unknown> }[] } {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const clean = text.replace(/```tool_call\s*\n([\s\S]*?)\n?```/g, (_m, body: string) => {
    try {
      const d = JSON.parse(body.trim());
      if (d && typeof d.name === "string")
        calls.push({ name: d.name, arguments: typeof d.arguments === "object" && d.arguments ? d.arguments : {} });
    } catch { /* malformed block: drop it */ }
    return "";
  }).trim();
  return { clean, calls };
}

const PORT = 8765; // loopback only, unlikely to collide

function findPython(): string | null {
  const candidates = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const c of candidates) {
    try {
      const r = Bun.spawnSync({ cmd: [c, "--version"], stdout: "ignore", stderr: "ignore" });
      if (r.exitCode === 0) return c;
    } catch { /* not found */ }
  }
  return null;
}

function ensureServerFile(): string {
  const dir = join(appDir(), "vendor", "gemini-web2api");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "gemini_web2api.py");
  let cur: string | null = null;
  try { cur = readFileSync(file, "utf8"); } catch { /* missing */ }
  if (cur !== FLASH_SERVER_PY) writeFileSync(file, FLASH_SERVER_PY, "utf8");
  return file;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

let baseUrl: string | null = null;
let proc: ChildProcess | null = null;
let starting: Promise<string> | null = null;

async function startFlashServer(): Promise<string> {
  if (baseUrl) return baseUrl;
  if (starting) return starting;
  starting = (async () => {
    // reuse an already-running instance (orphans from a previous session)
    if (await healthy(PORT)) { baseUrl = `http://127.0.0.1:${PORT}/v1`; return baseUrl; }
    const py = findPython();
    if (!py)
      throw new Error(
        "Goated-Flash-Free needs Python 3.8+ on PATH (it bridges a free Gemini endpoint).\n" +
        "  Install from https://python.org (check “Add to PATH”), or add your own key: /auth <provider> --key ***",
      );
    const script = ensureServerFile();
    proc = spawn(py, ["-u", script, "--port", String(PORT)], {
      cwd: tmpdir(),
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    proc.on("exit", () => { proc = null; baseUrl = null; });
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(250);
      if (await healthy(PORT)) { baseUrl = `http://127.0.0.1:${PORT}/v1`; return baseUrl; }
    }
    try { proc?.kill(); } catch { /* */ }
    proc = null;
    throw new Error("Goated-Flash-Free server did not start (firewall or port 8765 blocked?)");
  })().finally(() => { starting = null; });
  return starting;
}

/** Kill the embedded server (called on clean process exit). */
export function stopFlashServer(): void {
  try { proc?.kill(); } catch { /* */ }
  proc = null;
}

/**
 * ChatClient that transparently boots the local proxy and speaks the plain
 * OpenAI wire format to it. Tool calls arrive in-band as ```tool_call blocks
 * and are converted by this client into structured toolCalls events.
 */
export class GoatedFlashFreeClient implements ChatClient {
  async *streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent> {
    const base = await startFlashServer();
    const client = makeClient("openai", base, {}) as ChatClient;
    // the proxy only knows its own model ids; force the flash default
    opts = { ...opts, model: opts.model.includes("gemini") ? opts.model : GEMINI_FREE_MODEL };
    let full = "";
    let emitted = 0;
    // Displayable prefix of the raw text: everything before an OPEN fence, or
    // (when fences are balanced) with complete tool_call blocks stripped. A
    // trailing partial fence ("`", "``") is held back until it resolves.
    const displayFor = (t: string): string => {
      let cut = t.length;
      if (t.endsWith("``")) cut = t.length - 2;
      else if (t.endsWith("`")) cut = t.length - 1;
      const fences = (t.slice(0, cut).match(/```/g) ?? []).length;
      if (fences % 2 === 1) return t.slice(0, t.lastIndexOf("```", cut));
      return flashToolCallsFromText(t.slice(0, cut)).clean;
    };
    for await (const ev of client.streamChat(messages, tools, opts)) {
      if (ev.textDelta) {
        full += ev.textDelta;
        const d = displayFor(full);
        if (d.length > emitted) { yield { textDelta: d.slice(emitted) }; emitted = d.length; }
      }
      if (ev.usage) yield ev;
      if (ev.toolCalls?.length) yield { toolCalls: ev.toolCalls };
      if (opts.signal?.aborted) return;
    }
    const d = displayFor(full);
    if (d.length > emitted) yield { textDelta: d.slice(emitted) };
    const { calls } = flashToolCallsFromText(full);
    if (calls.length) {
      yield {
        toolCalls: calls.map((c, i) => ({
          id: `call_flash_${Date.now()}_${i}`, name: c.name, arguments: c.arguments,
        })),
      };
    }
  }
}
