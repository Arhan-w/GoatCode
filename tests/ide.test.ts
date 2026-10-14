/**
 * IDE server tests — `goat ide` HTTP surface: auth, cwd jail, file read/write,
 * tree, and a full agent.run turn streamed over SSE against an in-test LLM
 * stub. The SSE reader is a single continuous loop (abandoned reads lose
 * chunks); action POSTs always carry the token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, type GoatConfig } from "../src/config.ts";

let home: string;
let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "goat-ide-home-"));
  root = mkdtempSync(join(tmpdir(), "goat-ide-root-"));
  savedEnv.GOATCODE_HOME = process.env.GOATCODE_HOME;
  process.env.GOATCODE_HOME = home;
  mkdirSync(root, { recursive: true });
  // NOTE: no process.chdir here — chdir'ing into a temp dir that afterEach
  // then deletes leaves the runner's cwd dangling (uv_cwd failures in every
  // later test on Linux). The subprocess gets `cwd: root` instead.
  writeFileSync(join(root, "hello.txt"), "hello world\n");
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* child may hold it briefly */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ditto */ }
});

function ideCfg(modelPort: number): GoatConfig {
  const cfg = loadConfig(home);
  cfg.endpoints.stub = { id: "stub", baseUrl: `http://127.0.0.1:${modelPort}/v1`, format: "openai", apiKey: "sk-stub", models: ["m1"], label: "stub" };
  cfg.model = "stub/m1";
  cfg.autoApprove = true;
  saveConfig(cfg);
  return loadConfig(home);
}

async function startLlmStub(reply: string): Promise<{ port: number; close(): void }> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const sse = new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            const chunk = (o: any) => c.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n"));
            chunk({ choices: [{ delta: { content: reply } }] });
            chunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      return sse;
    },
  });
  return { port: server.port ?? 0, close: () => server.stop(true) };
}

describe("goat ide", () => {
  test("shell, vendored monaco, auth jail, file r/w, SSE turn end-to-end", async () => {
    const stub = await startLlmStub("ide answer 42");
    const cfg = ideCfg(stub.port);
    void cfg;

    const { spawn } = await import("node:child_process");
    const entry = join(import.meta.dir, "..", "src", "index.ts");
    const child = spawn(process.execPath, [entry, "ide", "--port", "0", "--no-open"], {
      cwd: root,
      env: { ...process.env, GOATCODE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => { out += d.toString(); });
    child.stderr!.on("data", (d) => { out += d.toString(); });

    let urlMatch: RegExpMatchArray | null = null;
    for (let i = 0; i < 100 && !urlMatch; i++) {
      urlMatch = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/);
      if (!urlMatch) await new Promise((r) => setTimeout(r, 100));
    }
    expect(urlMatch).not.toBeNull();
    const [, port, token] = urlMatch!;
    const base = `http://127.0.0.1:${port}`;

    try {
      // shell serves the IDE HTML
      const shell = await fetch(base + "/");
      expect(shell.status).toBe(200);
      const html = await shell.text();
      expect(html).toContain("GoatCode IDE");
      // vendored Monaco loads
      expect((await fetch(base + "/vendor/vs/loader.js")).status).toBe(200);
      expect((await fetch(base + "/vendor/vs/editor/editor.main.js")).status).toBe(200);

      // auth boundary
      expect((await fetch(base + "/api/state?token=wrong")).status).toBe(401);

      // state + tree
      const st = await (await fetch(`${base}/api/state?token=${token}`)).json();
      expect(st.version).toBeTruthy();
      const tr = await (await fetch(`${base}/api/tree?token=${token}`)).json();
      expect(tr.tree.some((n: any) => n.name === "hello.txt")).toBe(true);

      // file read + path jail + write
      const f = await (await fetch(`${base}/api/file?token=${token}&path=hello.txt`)).json();
      expect(f.content).toBe("hello world\n");
      expect((await fetch(`${base}/api/file?token=${token}&path=../escape.txt`)).status).toBe(400);
      const w = await (await fetch(base + "/api/file", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goat-token": token },
        body: JSON.stringify({ path: "made-by-ide.txt", content: "written" }),
      })).json();
      expect(w.ok).toBe(true);
      expect(readFileSync(join(root, "made-by-ide.txt"), "utf8")).toBe("written");

      // SSE: ONE continuous reader (abandoned reads drop chunks)
      const sse = await fetch(`${base}/api/events?token=${token}`);
      expect(sse.headers.get("content-type")).toContain("text/event-stream");
      const events: any[] = [];
      const reader = sse.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sseOpen = true;
      const readLoop = (async () => {
        while (sseOpen) {
          let t: any;
          try { t = await reader.read(); } catch { break; }
          if (t.done) break;
          buf += dec.decode(t.value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
        }
      })();

      // let hello arrive
      for (let i = 0; i < 20 && !events.some((e) => e.kind === "hello"); i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(events.some((e) => e.kind === "hello")).toBe(true);

      // bypass mode so the turn never needs a permission round-trip
      await fetch(base + "/api/action", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goat-token": token },
        body: JSON.stringify({ action: "mode", mode: "bypass" }),
      });
      await fetch(base + "/api/action", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goat-token": token },
        body: JSON.stringify({ action: "prompt", text: "say hi" }),
      });

      // wait for the turn to complete (>=2 busy-false state events) or 20s
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (events.filter((e) => e.kind === "state" && e.busy === false).length >= 2) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      sseOpen = false;
      try { await reader.cancel(); } catch { /* already closed */ }
      await readLoop.catch(() => {});

      const texts = events.filter((e) => e.kind === "agent" && e.ev?.kind === "text").map((e) => e.ev.text).join("");
      expect(texts).toContain("ide answer 42");
      expect(events.some((e) => e.kind === "user")).toBe(true);
      expect(events.some((e) => e.kind === "state" && e.busy === false)).toBe(true);
    } finally {
      child.kill();
      stub.close();
      try { rmSync(join(root, "made-by-ide.txt"), { force: true }); } catch { /* cleanup */ }
    }
  }, 45_000);
});
