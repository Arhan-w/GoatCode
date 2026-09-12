/**
 * Protocol tests — JSON-RPC codec, serve security boundaries (auth, method
 * allowlist, body cap, cwd jail), and a real agent.run round-trip against an
 * in-test LLM stub. Collab/relay tests live in collab.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, type GoatConfig } from "../src/config.ts";
import { ProviderRegistry } from "../src/providers.ts";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "goat-proto-"));
  savedEnv.GOATCODE_HOME = process.env.GOATCODE_HOME;
  process.env.GOATCODE_HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

// ---------- codec ----------
describe("rpc codec", () => {
  test("parseRequest accepts valid, rejects malformed", async () => {
    const { parseRequest } = await import("../src/protocol/rpc.ts");
    const ok = parseRequest(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "agent.run", params: { prompt: "hi" } }));
    expect(ok.ok).toBe(true);
    if (ok.ok) { expect(ok.id).toBe(7); expect(ok.method).toBe("agent.run"); }
    expect(parseRequest("not json").ok).toBe(false);
    expect(parseRequest(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "x" })).ok).toBe(false);
    expect(parseRequest(JSON.stringify({ jsonrpc: "2.0", method: "" })).ok).toBe(false);
    expect(parseRequest(JSON.stringify([1, 2])).ok).toBe(false);
  });

  test("encodeResult/encodeError round-trip", async () => {
    const { encodeResult, encodeError, parseRequest } = await import("../src/protocol/rpc.ts");
    const r = JSON.parse(encodeResult("abc", { text: "hi" }));
    expect(r.result.text).toBe("hi");
    expect(r.id).toBe("abc");
    const e = JSON.parse(encodeError(1, -32601, "Method not found"));
    expect(e.error.code).toBe(-32601);
    void parseRequest;
  });

  test("tokenOk: equal true, different length or chars false", async () => {
    const { tokenOk } = await import("../src/protocol/rpc.ts");
    expect(tokenOk("secret123", "secret123")).toBe(true);
    expect(tokenOk("secret123", "secret124")).toBe(false);
    expect(tokenOk("short", "muchlonger")).toBe(false);
    expect(tokenOk("", "")).toBe(true);
  });
});

// ---------- remote client unit surface ----------
describe("remote client", () => {
  test("remoteToolSpec names remote_<name>", async () => {
    const { remoteToolSpec, remoteTokenEnv } = await import("../src/protocol/client.ts");
    expect(remoteToolSpec({ name: "worker" }).name).toBe("remote_worker");
    expect(remoteTokenEnv("ci-box")).toBe("GOAT_REMOTE_TOKEN_CI_BOX");
    expect(remoteTokenEnv("web").startsWith("GOAT_REMOTE_TOKEN_")).toBe(true);
  });

  test("unreachable URL gives a clean LLMError", async () => {
    const { RemoteGoat } = await import("../src/protocol/client.ts");
    const g = new RemoteGoat({ url: "http://127.0.0.1:1", name: "gone", token: "t" });
    let err = "";
    try { await g.capabilities(); } catch (e: any) { err = e.message; }
    expect(err).toContain("gone");
    expect(err.toLowerCase()).toContain("unreachable");
  });
});

// ---------- serve: LLM stub + server ----------
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

function protoCfg(modelPort: number): GoatConfig {
  const cfg = loadConfig(home);
  const ep = { id: "stub", baseUrl: `http://127.0.0.1:${modelPort}/v1`, format: "openai" as const, apiKey: "sk-stub", models: ["m1"], label: "stub" };
  cfg.endpoints.stub = ep;
  cfg.model = "stub/m1";
  saveConfig(cfg);
  const cfg2 = loadConfig(home);
  return cfg2;
}

async function rpc(port: number, token: string, body: string, path = "/rpc") {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
}

describe("serve (real HTTP, 127.0.0.1 ephemeral)", () => {
  test("auth: wrong/missing token rejected, health open", async () => {
    const stub = await startLlmStub("ok");
    const { startServe } = await import("../src/protocol/serve.ts");
    const cfg = protoCfg(stub.port);
    const reg = new ProviderRegistry(cfg.endpoints);
    const handle = await startServe({ cfg, registry: reg, port: 0, token: "right-token" });
    try {
      const bad = await rpc(handle.port, "wrong", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.capabilities" }));
      expect(bad.status).toBe(401);
      const none = await rpc(handle.port, "", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.capabilities" }));
      expect(none.status).toBe(401);
      const h = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(await h.text()).toBe("ok");
    } finally { handle.close(); stub.close(); }
  }, 30000);

  test("capabilities lists tools WITHOUT bash; unknown method -> -32601", async () => {
    const stub = await startLlmStub("ok");
    const { startServe } = await import("../src/protocol/serve.ts");
    const cfg = protoCfg(stub.port);
    const handle = await startServe({ cfg, registry: new ProviderRegistry(cfg.endpoints), port: 0, token: "tk" });
    try {
      const res = await rpc(handle.port, "tk", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.capabilities" }));
      const j: any = await res.json();
      expect(j.result.methods).toContain("agent.run");
      expect(j.result.tools).toContain("read");
      expect(j.result.tools).not.toContain("bash");
      const bad = await rpc(handle.port, "tk", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "no.such" }));
      const bj: any = await bad.json();
      expect(bj.error.code).toBe(-32601);
    } finally { handle.close(); stub.close(); }
  }, 30000);

  test("agent.run end-to-end returns stub text + usage; cwd jail enforced", async () => {
    const stub = await startLlmStub("remote answer 42");
    const { startServe } = await import("../src/protocol/serve.ts");
    const cfg = protoCfg(stub.port);
    const handle = await startServe({ cfg, registry: new ProviderRegistry(cfg.endpoints), port: 0, token: "tk" });
    try {
      const res = await rpc(handle.port, "tk", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "agent.run", params: { prompt: "say hi" } }));
      const j: any = await res.json();
      expect(j.result.text).toContain("remote answer 42");
      expect(typeof j.result.session_id).toBe("string");
      expect(j.result.usage.input_tokens).toBeGreaterThan(0);
      // cwd escape rejected
      const esc = await rpc(handle.port, "tk", JSON.stringify({ jsonrpc: "2.0", id: 4, method: "agent.run", params: { prompt: "x", cwd: "C:\\Windows" } }));
      const ej: any = await esc.json();
      expect(ej.error?.message ?? "").toContain("cwd outside allowed roots");
    } finally { handle.close(); stub.close(); }
  }, 60000);

  test("oversized body rejected 413", async () => {
    const stub = await startLlmStub("ok");
    const { startServe } = await import("../src/protocol/serve.ts");
    const cfg = protoCfg(stub.port);
    const handle = await startServe({ cfg, registry: new ProviderRegistry(cfg.endpoints), port: 0, token: "tk" });
    try {
      const big = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "agent.run", params: { prompt: "x".repeat(1_100_000) } });
      const res = await rpc(handle.port, "tk", big);
      expect(res.status).toBe(413);
    } finally { handle.close(); stub.close(); }
  }, 30000);

  test("startServe refuses without a token", async () => {
    const stub = await startLlmStub("ok");
    const { startServe } = await import("../src/protocol/serve.ts");
    const cfg = protoCfg(stub.port);
    let msg = "";
    try { await startServe({ cfg, registry: new ProviderRegistry(cfg.endpoints), port: 0, token: "" }); }
    catch (e: any) { msg = e.message; }
    expect(msg).toContain("GOAT_AGENT_TOKEN");
    stub.close();
  }, 15000);
});
