/**
 * GoatCode v2 test suite — bun test.
 * Mirrors the Python suite's regression coverage: sandbox escapes, provider
 * id alignment, SSE parsing, Anthropic tool-result merging, compaction
 * boundaries, config layering. No network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "goat-test-"));
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

// ---------- config ----------
describe("config", () => {
  test("layered load: env overrides file", async () => {
    const { loadConfig, saveConfig, splitModel } = await import("../src/config.ts");
    process.env.GOAT_MODEL = "groq/llama-3.3-70b";
    const cfg = loadConfig(home);
    expect(cfg.model).toBe("groq/llama-3.3-70b");
    expect(cfg.provider).toBe("groq");
    expect(cfg.modelId).toBe("llama-3.3-70b");
    delete process.env.GOAT_MODEL;
    void saveConfig; void splitModel;
  });

  test("project goatcode.json wins over user config", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const proj = mkdtempSync(join(tmpdir(), "goat-proj-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ model: "openai/gpt-4o" }));
    writeFileSync(join(proj, "goatcode.json"), JSON.stringify({ model: "deepseek/deepseek-chat" }));
    const cfg = loadConfig(proj);
    expect(cfg.model).toBe("deepseek/deepseek-chat");
    rmSync(proj, { recursive: true, force: true });
  });

  test(".mcp.json merges into mcpServers", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const proj = mkdtempSync(join(tmpdir(), "goat-mcp-"));
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({
      mcpServers: { fs: { type: "stdio", command: "npx", args: ["-y", "server"] } },
    }));
    const cfg = loadConfig(proj);
    expect(cfg.mcpServers.fs).toBeDefined();
    expect((cfg.mcpServers.fs as any).command).toBe("npx");
    rmSync(proj, { recursive: true, force: true });
  });
});

// ---------- providers ----------
describe("providers", () => {
  test("ENV_KEY_FALLBACK ids all exist in catalog", async () => {
    const { ENV_KEY_FALLBACK, loadCatalog } = await import("../src/providers.ts");
    const catalog = loadCatalog();
    for (const pid of Object.keys(ENV_KEY_FALLBACK))
      expect(catalog.has(pid)).toBe(true);
  });

  test("normalizeBaseUrl strips endpoint suffixes", async () => {
    const { normalizeBaseUrl } = await import("../src/providers.ts");
    expect(normalizeBaseUrl("https://api.x.com/v1/chat/completions")).toBe("https://api.x.com/v1");
    expect(normalizeBaseUrl("https://api.x.com/v1/messages/")).toBe("https://api.x.com/v1");
    expect(normalizeBaseUrl("https://api.x.com/v1/responses")).toBe("https://api.x.com/v1");
  });

  test("credential store round-trip + remove", async () => {
    const { CredentialStore } = await import("../src/providers.ts");
    const store = new CredentialStore(join(home, "creds.json"));
    store.put("openai", { kind: "api_key", apiKey: "sk-test", expiresAt: 0 });
    expect(store.get("openai")?.apiKey).toBe("sk-test");
    expect(store.remove("openai")).toBe(true);
    expect(store.get("openai")).toBeNull();
  });

  test("oauth expiry margin", async () => {
    const { credentialValid } = await import("../src/providers.ts");
    const now = Date.now() / 1000;
    expect(credentialValid({ kind: "oauth", accessToken: "t", expiresAt: now + 3600 })).toBe(true);
    expect(credentialValid({ kind: "oauth", accessToken: "t", expiresAt: now + 30 })).toBe(false); // <60s margin
    expect(credentialValid({ kind: "oauth", accessToken: "t", expiresAt: 0 })).toBe(true); // never
  });

  test("resolveCredential env fallback", async () => {
    const { ProviderRegistry } = await import("../src/providers.ts");
    process.env.GROQ_API_KEY = "gsk-env-test";
    const reg = new ProviderRegistry();
    const cred = reg.resolveCredential("groq");
    expect(cred?.apiKey).toBe("gsk-env-test");
    delete process.env.GROQ_API_KEY;
  });
});

// ---------- tools / sandbox ----------
describe("tools", () => {
  test("path sandbox rejects sibling-prefix escape", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-root-"));
    mkdirSync(root + "secret", { recursive: true });
    const tk = new ToolKit(root, { autoApprove: true });
    expect(() => tk.inside("../" + (root + "secret").split(/[\\/]/).pop())).toThrow();
    expect(() => tk.inside(root + "secret/x.txt")).toThrow();
    rmSync(root, { recursive: true, force: true });
    rmSync(root + "secret", { recursive: true, force: true });
  });

  test("read returns numbered lines", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-root-"));
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree");
    const tk = new ToolKit(root, { autoApprove: true });
    const r = tk.tool_read({ path: "a.txt" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("1\tone");
    rmSync(root, { recursive: true, force: true });
  });

  test("edit requires unique match", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-root-"));
    writeFileSync(join(root, "b.txt"), "dup\ndup\n");
    const tk = new ToolKit(root, { autoApprove: true });
    const r = await tk.dispatch("edit", { path: "b.txt", old_string: "dup", new_string: "x" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("matches 2 times");
    rmSync(root, { recursive: true, force: true });
  });

  test("glob + grep find files", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-root-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "c.ts"), "export const needle = 1;");
    const tk = new ToolKit(root, { autoApprove: true });
    expect(tk.tool_glob({ pattern: "src/**/*.ts" }).output).toContain("c.ts");
    expect(tk.tool_grep({ pattern: "needle" }).output).toContain("needle");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- llm ----------
describe("llm", () => {
  test("anthropic converter merges consecutive tool results into one user turn", async () => {
    const { AnthropicClient } = await import("../src/llm.ts");
    const { system, msgs } = AnthropicClient.systemAndMessages([
      { role: "system", content: "base" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [
        { id: "a", name: "read", arguments: {} },
        { id: "b", name: "grep", arguments: {} },
      ] },
      { role: "tool", content: "r1", toolCallId: "a", name: "read" },
      { role: "tool", content: "r2", toolCallId: "b", name: "grep" },
    ]);
    expect(system).toBe("base");
    const lastUser = msgs[msgs.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content.length).toBe(2); // merged, not two turns
    expect(lastUser.content.every((b: any) => b.type === "tool_result")).toBe(true);
  });

  test("anthropic converter concatenates system messages", async () => {
    const { AnthropicClient } = await import("../src/llm.ts");
    const { system } = AnthropicClient.systemAndMessages([
      { role: "system", content: "one" },
      { role: "system", content: "two" },
    ]);
    expect(system).toContain("one");
    expect(system).toContain("two");
  });

  test("gemini converter merges function responses", async () => {
    const { GeminiClient } = await import("../src/llm.ts");
    const { contents } = GeminiClient.contentsAndSystem([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [
        { id: "a", name: "read", arguments: {} },
        { id: "b", name: "grep", arguments: {} },
      ] },
      { role: "tool", content: "r1", toolCallId: "a", name: "read" },
      { role: "tool", content: "r2", toolCallId: "b", name: "grep" },
    ]);
    const last = contents[contents.length - 1];
    expect(last.role).toBe("user");
    expect(last.parts.length).toBe(2);
  });

  test("openai SSE parses tool-call deltas by index", async () => {
    const { OpenAIChatClient } = await import("../src/llm.ts");
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const client = new OpenAIChatClient("http://mock");
    const fakeFetch = () => Promise.resolve(new Response(body, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as any;
    try {
      let toolCalls: any = null;
      for await (const ev of client.streamChat([{ role: "user", content: "hi" }], [], { model: "m", maxTokens: 10 }))
        if (ev.toolCalls) toolCalls = ev.toolCalls;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("read");
      expect(toolCalls[0].arguments).toEqual({ path: "x" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------- agent ----------
describe("agent", () => {
  test("compaction never starts window on a tool message", async () => {
    const { Agent, COMPACT_TRIGGER_CHARS } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const session = Session.new(home, "mock/m");
    // fill with big messages so compaction triggers (>220k chars AND >12 msgs).
    // Pattern: user, user, tool, user, user, tool, ... ensures the cut point
    // lands on a tool message that must be advanced past.
    const big = "x".repeat(8_000);
    for (let i = 0; i < 30; i++) {
      const role = i % 3 === 2 ? "tool" : "user";
      session.messages.push({
        role, content: big,
        ...(role === "tool" ? { toolCallId: `t${i}`, name: "read" } : {}),
      });
    }
    const agent = new Agent({
      client: null as any, session, tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 100, temperature: null, maxSteps: 1,
    });
    (agent as any).maybeCompact();
    expect(session.compactedFrom).toBeGreaterThan(0);
    expect(session.messages[session.compactedFrom].role).not.toBe("tool");
    void COMPACT_TRIGGER_CHARS;
  });

  test("modelId strips provider prefix", async () => {
    const { modelId } = await import("../src/agent.ts");
    expect(modelId("openrouter/deepseek-ai/deepseek-v3.2")).toBe("deepseek-ai/deepseek-v3.2");
    expect(modelId("gpt-4o")).toBe("gpt-4o");
  });
});

// ---------- session ----------
describe("session", () => {
  test("save/load round-trip", async () => {
    const { Session } = await import("../src/session.ts");
    const s = Session.new(home, "mock/m");
    s.title = "test session";
    s.append({ role: "user", content: "hello" });
    s.append({ role: "assistant", content: "hi", toolCalls: [{ id: "1", name: "read", arguments: { path: "a" } }] });
    s.save();
    const t = Session.loadById(s.id);
    expect(t.title).toBe("test session");
    expect(t.messages.length).toBe(2);
    expect((t.messages[1] as any).toolCalls[0].name).toBe("read");
  });

  test("listSessions finds saved sessions", async () => {
    const { Session, listSessions } = await import("../src/session.ts");
    const s = Session.new(home, "mock/m");
    s.title = "listed";
    s.save();
    const rows = listSessions();
    expect(rows.some((r) => r.id === s.id && r.title === "listed")).toBe(true);
  });
});

// ---------- skills ----------
describe("skills", () => {
  test("SKILL.md frontmatter parses", async () => {
    const { loadSkills } = await import("../src/skills/loader.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-sk-"));
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill\nwhen_to_use: For testing\n---\n\nBody here.\n");
    const skills = loadSkills(root);
    expect(skills.length).toBe(1);
    expect(skills[0].description).toBe("A demo skill");
    expect(skills[0].whenToUse).toBe("For testing");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- commands ----------
describe("commands", () => {
  test("SLASH_COMMANDS covers the palette", async () => {
    const { SLASH_COMMANDS } = await import("../src/commands.tsx");
    for (const c of ["/help", "/model", "/providers", "/auth", "/mcp", "/skills", "/quit"])
      expect(SLASH_COMMANDS).toContain(c);
  });
});

// ---------- @file refs ----------
describe("file refs", () => {
  test("@path expands to fenced content; escapes left alone", async () => {
    const { expandFileRefs } = await import("../src/tui.tsx");
    const root = mkdtempSync(join(tmpdir(), "goat-ref-"));
    writeFileSync(join(root, "hello.txt"), "world");
    const out = expandFileRefs("summarize @hello.txt please", root);
    expect(out).toContain("[file: hello.txt]");
    expect(out).toContain("world");
    // outside root → untouched
    expect(expandFileRefs("@../secret.txt", root)).toContain("@../secret.txt");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- plan-mode ----------
describe("plan mode", () => {
  test("readonly Toolkit blocks mutating ops up front", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-plan-"));
    writeFileSync(join(root, "f.txt"), "hello");
    const tk = new ToolKit(root, { readonly: true });
    const write = await tk.dispatch("write", { path: "f.txt", content: "bye" });
    expect(write.ok).toBe(false);
    expect((write as any).output).toContain("plan mode");
    const edit = await tk.dispatch("edit", { path: "f.txt", old_string: "hello", new_string: "bye" });
    expect(edit.ok).toBe(false);
    expect((edit as any).output).toContain("plan mode");
    const bash = await tk.dispatch("bash", { command: "echo hi" });
    expect(bash.ok).toBe(false);
    expect((bash as any).output).toContain("plan mode");
    // reads still work
    const read = tk.tool_read({ path: "f.txt" });
    expect(read.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- undo / checkpoints ----------
describe("undo", () => {
  test("undo restores an edited file", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-undo-"));
    writeFileSync(join(root, "u.txt"), "original");
    const tk = new ToolKit(root, { autoApprove: true });
    await tk.dispatch("edit", { path: "u.txt", old_string: "original", new_string: "changed" });
    expect(readFileSync(join(root, "u.txt"), "utf8")).toBe("changed");
    const rec = tk.undo();
    expect(rec?.path).toContain("u.txt");
    expect(readFileSync(join(root, "u.txt"), "utf8")).toBe("original");
    rmSync(root, { recursive: true, force: true });
  });

  test("undo of a created file deletes it", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-undo-"));
    const tk = new ToolKit(root, { autoApprove: true });
    await tk.dispatch("write", { path: "new.txt", content: "born here" });
    expect(existsSync(join(root, "new.txt"))).toBe(true);
    tk.undo();
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("undoCheckpoint reverts a whole turn, later turns stay", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-undo-"));
    writeFileSync(join(root, "a.txt"), "A0");
    writeFileSync(join(root, "b.txt"), "B0");
    const tk = new ToolKit(root, { autoApprove: true });
    // turn 1 edits a and b
    tk.beginCheckpoint();
    await tk.dispatch("edit", { path: "a.txt", old_string: "A0", new_string: "A1" });
    await tk.dispatch("edit", { path: "b.txt", old_string: "B0", new_string: "B1" });
    // turn 2 writes a new file
    tk.beginCheckpoint();
    await tk.dispatch("write", { path: "c.txt", content: "C" });
    // undoing the last turn deletes c.txt only
    expect(tk.undoCheckpoint()).toBe(1);
    expect(existsSync(join(root, "c.txt"))).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A1");
    // undoing the first turn restores a and b
    expect(tk.undoCheckpoint()).toBe(2);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A0");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("B0");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- background bash ----------
describe("background bash", () => {
  test("background:true returns immediately and tasks tool lists it", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-bg-"));
    const tk = new ToolKit(root, { autoApprove: true });
    const t0 = Date.now();
    const r = await tk.dispatch("bash", { command: "timeout 2 2>nul || sleep 2", background: true });
    expect(Date.now() - t0).toBeLessThan(1500); // didn't wait for the 2s command
    expect(r.ok).toBe(true);
    expect((r as any).output).toContain("background task");
    const id = ((r as any).output.match(/task (bg_\S+)/) ?? [])[1];
    expect(id).toBeTruthy();
    expect(tk.backgroundTasks().some((t) => t.id === id)).toBe(true);
    const listed = await tk.dispatch("tasks", {});
    expect((listed as any).output).toContain(id);
    // wait for completion, status changes
    await new Promise((res) => setTimeout(res, 2600));
    const done = tk.backgroundTasks().find((t) => t.id === id)!;
    expect(done.status).not.toBe("running");
    rmSync(root, { recursive: true, force: true });
  });
});
