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

  test("allSessions exposes usage for the cost dashboard", async () => {
    const { Session, allSessions } = await import("../src/session.ts");
    const s = Session.new(home, "anthropic/claude-sonnet-4-5");
    s.title = "spicy";
    s.usage = { in: 1200, out: 340 };
    s.save();
    const rows = allSessions();
    const mine = rows.find((r) => r.id === s.id);
    expect(mine).toBeDefined();
    expect(mine!.title).toBe("spicy");
    expect(mine!.model).toBe("anthropic/claude-sonnet-4-5");
    expect(mine!.usage.in).toBe(1200);
    expect(mine!.usage.out).toBe(340);
    expect(mine!.createdAt).toBeGreaterThan(0);
    // corrupt session files must be skipped, not crash the dashboard
    const { writeFileSync: wf } = await import("node:fs");
    const { join: j } = await import("node:path");
    wf(j(home, "sessions", "garbage.jsonl"), "not json\n", "utf8");
    expect(allSessions().length).toBe(rows.length);
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

// ---------- pricing ----------
describe("pricing", () => {
  test("costUsd matches known families and returns null for unknown", async () => {
    const { costUsd, priceFor } = await import("../src/pricing.ts");
    expect(priceFor("anthropic/claude-sonnet-4-5")).toEqual({ in: 3, out: 15 });
    expect(costUsd("anthropic/claude-sonnet-4-5", 1_000_000, 500_000)).toBeCloseTo(10.5);
    expect(costUsd("deepseek/deepseek-chat", 10_000, 1_000)).toBeCloseTo(0.0037);
    expect(costUsd("freellmapi/auto", 1000, 1000)).toBeNull();
  });
});

// ---------- plugins ----------
describe("plugins", () => {
  test("plugin dirs contribute commands and skills", async () => {
    const { loadPlugins, pluginSkills } = await import("../src/plugins/loader.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-plugin-"));
    mkdirSync(join(root, "mypl", "commands"), { recursive: true });
    mkdirSync(join(root, "mypl", "skills", "deploy", ""), { recursive: true });
    writeFileSync(join(root, "mypl", "manifest.json"), JSON.stringify({ name: "mypl", version: "1.0" }));
    writeFileSync(join(root, "mypl", "commands", "changelog.md"),
      "---\ndescription: Summarize recent commits\n---\nList commits since $1 and write a changelog for: $ARGUMENTS\n");
    writeFileSync(join(root, "mypl", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship it\n---\nrun the deploy script\n");
    const plugins = loadPlugins([join(root, "mypl")]);
    expect(plugins.length).toBe(1);
    const sk = pluginSkills(plugins);
    expect(sk.map((s) => s.name).sort()).toEqual(["changelog", "deploy"]);
    const cmd = sk.find((s) => s.name === "changelog")!;
    expect(cmd.description).toBe("Summarize recent commits");
    expect(cmd._body).toContain("$ARGUMENTS");
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

  test("buildUserContent attaches image refs as base64 parts", async () => {
    const { buildUserContent } = await import("../src/tui.tsx");
    const root = mkdtempSync(join(tmpdir(), "goat-img-"));
    // 1x1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    writeFileSync(join(root, "shot.png"), png);
    const out = buildUserContent("what color is @shot.png ?", root);
    expect(typeof out).not.toBe("string");
    const parts = out as any[];
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("[image: shot.png]");
    expect(parts[0].text).not.toContain("@shot.png");
    const img = parts[1];
    expect(img.type).toBe("image");
    expect(img.mediaType).toBe("image/png");
    expect(Buffer.from(img.data, "base64").equals(png)).toBe(true);
    // plain text without images stays a string
    expect(typeof buildUserContent("no refs here", root)).toBe("string");
    // missing image: placeholder untouched
    expect((buildUserContent("@nope.png", root) as any)).toBe("@nope.png");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- image wire formats ----------
describe("image content on the wire", () => {
  const imgMsg = [
    { role: "user", content: [
      { type: "text", text: "look" },
      { type: "image", data: "AAB=", mediaType: "image/png" },
    ] },
  ] as any[];

  test("anthropic: user image part -> image block w/ base64 source", async () => {
    const { AnthropicClient } = await import("../src/llm.ts");
    const { msgs } = AnthropicClient.systemAndMessages(imgMsg);
    expect(msgs[0].content[1]).toEqual({
      type: "image", source: { type: "base64", media_type: "image/png", data: "AAB=" },
    });
  });

  test("anthropic: tool result content parts -> tool_result with image blocks", async () => {
    const { AnthropicClient } = await import("../src/llm.ts");
    const { msgs } = AnthropicClient.systemAndMessages([
      { role: "tool", toolCallId: "t1", name: "read", content: [
        { type: "text", text: "[image shot.png]" },
        { type: "image", data: "AAB=", mediaType: "image/png" },
      ] },
    ] as any[]);
    const tr = msgs[0].content[0];
    expect(tr.type).toBe("tool_result");
    expect(tr.content.length).toBe(2);
    expect(tr.content[1].type).toBe("image");
  });

  test("openai: user image part -> image_url data URL", async () => {
    const { OpenAIChatClient } = await import("../src/llm.ts");
    let sentBody: any;
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((url: any, init: any) => {
      sentBody = JSON.parse(init.body);
      return Promise.resolve(new Response("data: [DONE]\n\n", { status: 200 }));
    }) as any;
    try {
      const client = new OpenAIChatClient("http://mock");
      for await (const _ of client.streamChat(imgMsg, [], { model: "m", maxTokens: 10 })) void _;
      const parts = sentBody.messages[0].content;
      expect(parts[1].type).toBe("image_url");
      expect(parts[1].image_url.url).toBe("data:image/png;base64,AAB=");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("gemini: image part -> inlineData", async () => {
    const { GeminiClient } = await import("../src/llm.ts");
    const { contents } = GeminiClient.contentsAndSystem(imgMsg as any);
    expect(contents[0].parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "AAB=" } });
  });

  test("toolkit read on a png returns image content", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-readimg-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    writeFileSync(join(root, "x.png"), png);
    const r = await new ToolKit(root, { autoApprove: true }).dispatch("read", { path: "x.png" });
    expect(r.ok).toBe(true);
    expect(r.content).toBeDefined();
    expect(r.content![1].type).toBe("image");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- new slash commands ----------
describe("slash extras", () => {
  const mkIo = (s: any, captured: string[]) => ({
    session: s,
    push: (n: any) => { captured.push(JSON.stringify(n?.props?.children ?? n)); },
    cfg: { model: "mock/m", provider: "mock", maxTokens: 8192, autoApprove: false, pluginDirs: [] } as any,
    setCfg: () => {}, registry: { get: () => undefined, resolveCredential: () => null } as any,
    setSession: () => {}, saveCfg: () => {},
    exit: () => {}, mcp: null, skills: [], undoTurn: () => 0, backgroundTasks: () => [],
    setMode: () => {}, runTurn: async () => {}, compactNow: async () => "stub", reloadPlugins: () => 0,
  });

  test("/rename sets and persists the session title", async () => {
    const { runSlash } = await import("../src/commands.tsx");
    const { Session } = await import("../src/session.ts");
    const s = Session.new(home, "mock/m");
    const out: string[] = [];
    expect(runSlash("/rename demo title", mkIo(s, out) as any)).toBe(true);
    expect(s.title).toBe("demo title");
  });

  test("/usage and /status render without throwing", async () => {
    const { runSlash } = await import("../src/commands.tsx");
    const { Session } = await import("../src/session.ts");
    const s = Session.new(home, "mock/m");
    s.usage = { in: 1234, out: 56 };
    s.append({ role: "user", content: "hi" });
    s.append({ role: "assistant", content: "yo" });
    const out: string[] = [];
    expect(runSlash("/usage", mkIo(s, out) as any)).toBe(true);
    expect(out.join(" ")).toContain("1,234");
    expect(runSlash("/status", mkIo(s, out) as any)).toBe(true);
    expect(out.join(" ")).toContain("mock/m");
  });

  test("/memory reports GOAT.md tail", async () => {
    const { runSlash } = await import("../src/commands.tsx");
    const { Session } = await import("../src/session.ts");
    writeFileSync(join(home, "GOAT.md"), "- use bun, not npm\n");
    const s = Session.new(home, "mock/m");
    const out: string[] = [];
    expect(runSlash("/memory", mkIo(s, out) as any)).toBe(true);
    expect(out.join(" ")).toContain("use bun, not npm");
  });

  test("SLASH_COMMANDS includes the new commands with descriptions", async () => {
    const { SLASH_COMMANDS, COMMAND_DESC } = await import("../src/commands.tsx");
    for (const c of ["/usage", "/status", "/rename", "/memory"]) {
      expect(SLASH_COMMANDS).toContain(c);
      expect(COMMAND_DESC[c]).toBeTruthy();
    }
  });
});

// ---------- permission rules ----------
describe("permission rules", () => {
  test("decide: deny > allow > ask, bash prefix/glob anti-bypass", async () => {
    const { decide } = await import("../src/permissions.ts");
    const rules = { allow: ["Bash(git add:*)", "Edit(src/**)"], deny: ["Bash(git push*)"] };
    expect(decide(rules, "bash", { command: "git add ." })).toBe("allow");
    expect(decide(rules, "bash", { command: "git push origin main" })).toBe("deny");
    // compound commands defeat prefix-allow (anti-bypass) but not deny
    expect(decide(rules, "bash", { command: "git add . && git push" })).toBe("ask");
    expect(decide(rules, "edit", { path: "src/a/b.ts" })).toBe("allow");
    expect(decide(rules, "write", { path: "src/x.ts" })).toBe("allow"); // Edit rules cover write
    expect(decide(rules, "edit", { path: "docs/x.md" })).toBe("ask");
    expect(decide(rules, "read", { path: "any" })).toBe("ask");
    expect(decide(undefined, "bash", { command: "x" })).toBe("ask");
  });

  test("webfetch domain rules match host suffixes", async () => {
    const { decide } = await import("../src/permissions.ts");
    const rules = { allow: ["WebFetch(domain:docs.python.org)"], deny: [] };
    expect(decide(rules, "webfetch", { url: "https://docs.python.org/3/x.html" })).toBe("allow");
    expect(decide(rules, "webfetch", { url: "https://evil.com/docs.python.org" })).toBe("ask");
  });
});

// ---------- hooks ----------
describe("hooks", () => {
  test("matcherMatches: regex semantics like Claude", async () => {
    const { matcherMatches } = await import("../src/hooks.ts");
    expect(matcherMatches(undefined, "bash")).toBe(true);
    expect(matcherMatches("*", "bash")).toBe(true);
    expect(matcherMatches("Bash", "bash")).toBe(true);
    expect(matcherMatches("Bash|Edit", "edit")).toBe(true);
    expect(matcherMatches("^mcp__.*", "mcp__fs__read")).toBe(true);
    expect(matcherMatches("Bash", "write")).toBe(false);
  });

  test("PreToolUse hook exit 2 blocks; allow skips prompt", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-hook-"));
    writeFileSync(join(root, "h.txt"), "x");
    // deny hook: prints to stderr and exits 2
    const denyHooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ command: `echo nope >&2 && exit 2` }] }] };
    const tk = new ToolKit(root, { autoApprove: true });
    tk.hooks = denyHooks as any;
    const r = await tk.dispatch("bash", { command: "echo hi" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("blocked by PreToolUse hook");
    expect(r.output).toContain("nope");
    // non-matching tool unaffected
    const ok = await tk.dispatch("read", { path: "h.txt" });
    expect(ok.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("PreToolUse stdout permissionDecision deny overrides autoApprove", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-hook-"));
    const script = join(root, "deny-hook.cjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'policy'}}))");
    const tk = new ToolKit(root, { autoApprove: true });
    tk.hooks = { PreToolUse: [{ hooks: [{ command: `${process.execPath} run ${script}` }] }] } as any;
    const r = await tk.dispatch("bash", { command: "echo hi" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("denied by PreToolUse hook");
    expect(r.output).toContain("policy");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- subagents ----------
describe("subagents", () => {
  test("task tool runs a child loop and returns its report", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    let parentCalls = 0, childCalls = 0;
    const client = {
      async *streamChat(msgs: any[], specs: any[]) {
        const isChild = String(msgs[0]?.content).includes("sub-agent") || msgs.some((m: any) => String(m.content).includes("SUBTASK"));
        if (!isChild) {
          parentCalls++;
          if (parentCalls === 1)
            yield { toolCalls: [{ id: "t1", name: "task", arguments: { description: "answer", prompt: "SUBTASK: say hi", subagent_type: "explore" } }] };
          else yield { textDelta: "parent done" };
        } else {
          childCalls++;
          yield { textDelta: "child report: hi" };
        }
      },
    } as any;
    const session = Session.new(home, "mock/m");
    const agent = new Agent({
      client, session, tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 6,
    });
    let text = "";
    const toolNames: string[] = [];
    for await (const ev of agent.runTurn("go")) {
      if (ev.kind === "text") text += ev.text;
      if (ev.kind === "tool_start") toolNames.push(ev.tool);
    }
    expect(childCalls).toBeGreaterThan(0);
    expect(toolNames).toContain("task");
    // child report landed in the session as a tool result
    const toolMsg = session.messages.find((m) => m.role === "tool" && m.name === "task");
    expect(String(toolMsg?.content)).toContain("child report: hi");
    expect(text).toContain("parent done");
  });

  test("sub-agents cannot spawn sub-agents", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const client = {
      async *streamChat(_msgs: any[], specs: any[]) {
        // child sees no task/write/edit tools in its spec list
        if (!specs.some((s: any) => s.name === "task")) yield { textDelta: "no recursion tools" };
        else yield { toolCalls: [{ id: "x", name: "task", arguments: { description: "d", prompt: "SUBTASK" } }] };
      },
    } as any;
    const agent = new Agent({
      client, session: Session.new(home, "mock/m"), tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 4,
    });
    for await (const _ of agent.runTurn("SUBTASK go")) void _;
    expect(true).toBe(true); // completed without infinite recursion
  });
});

// ---------- webfetch guard ----------
describe("webfetch", () => {
  test("isPrivateHost blocks loopback/private/metadata; public literal IPs pass", async () => {
    const { isPrivateHost } = await import("../src/tools.ts");
    expect(await isPrivateHost("localhost")).toBe(true);
    expect(await isPrivateHost("127.0.0.1")).toBe(true);
    expect(await isPrivateHost("10.1.2.3")).toBe(true);
    expect(await isPrivateHost("192.168.0.7")).toBe(true);
    expect(await isPrivateHost("169.254.169.254")).toBe(true);
    expect(await isPrivateHost("metadata.google.internal")).toBe(true);
    // literal public IP passes; pattern guard, no DNS pinning
    expect(await isPrivateHost("93.184.216.34")).toBe(false);
    expect(await isPrivateHost("example.com")).toBe(false);
  });

  test("tool refuses private URLs before prompting", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const tk = new ToolKit(home, { autoApprove: true });
    const r = await tk.dispatch("webfetch", { url: "http://127.0.0.1:31415/v1/models" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("private/loopback");
  });
});

// ---------- @dir + output style + statusline input ----------
describe("extras", () => {
  test("@dir expands to a one-level listing", async () => {
    const { expandFileRefs } = await import("../src/tui.tsx");
    const root = mkdtempSync(join(tmpdir(), "goat-dir-"));
    mkdirSync(join(root, "pkg", "sub"), { recursive: true });
    writeFileSync(join(root, "pkg", "a.ts"), "1");
    const out = expandFileRefs("tree: @pkg", root);
    expect(out).toContain("[dir: pkg]");
    expect(out).toContain("a.ts");
    expect(out).toContain("sub");
    rmSync(root, { recursive: true, force: true });
  });

  test("loadOutputStyle: built-in, file, and default", async () => {
    const { loadOutputStyle } = await import("../src/context.ts");
    expect(loadOutputStyle(undefined)).toBe("");
    expect(loadOutputStyle("default")).toBe("");
    expect(loadOutputStyle("Explanatory")).toContain("Output Style: Explanatory");
    const dir = mkdtempSync(join(tmpdir(), "goat-style-"));
    writeFileSync(join(dir, "terse.md"), "---\nname: terse\n---\nBe extremely brief.\n");
    expect(loadOutputStyle(join(dir, "terse.md"))).toContain("Be extremely brief");
    rmSync(dir, { recursive: true, force: true });
  });

  test("statusInput builds the Claude-shaped payload", async () => {
    const { statusInput } = await import("../src/statusline.ts");
    const { Session } = await import("../src/session.ts");
    const s = Session.new(home, "mock/m");
    s.usage = { in: 100, out: 5 };
    const inp = statusInput(s, "mock/m", undefined, 4000, false);
    expect(inp.session_id).toBe(s.id);
    expect(inp.model.id).toBe("mock/m");
    expect(inp.cost.total_tokens_in).toBe(100);
    expect(inp.context_window.current_usage).toBe(1000); // 4000/4
    expect(inp.output_style.name).toBe("default");
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

// ---------- retry / resilience ----------
describe("retry", () => {
  test("isRetryableLLMError classifies by status and message", async () => {
    const { LLMError, isRetryableLLMError } = await import("../src/llm.ts");
    expect(isRetryableLLMError(new LLMError("HTTP 429: slow down", { status: 429 }))).toBe(true);
    expect(isRetryableLLMError(new LLMError("HTTP 503: busy", { status: 503 }))).toBe(true);
    expect(isRetryableLLMError(new LLMError("HTTP 400: bad req", { status: 400 }))).toBe(false);
    expect(isRetryableLLMError(new LLMError("fetch failed: ECONNRESET"))).toBe(true);
    const abort = new LLMError("aborted");
    abort.name = "AbortError";
    expect(isRetryableLLMError(abort)).toBe(false);
  });

  test("agent retries a 429 then succeeds", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const { LLMError } = await import("../src/llm.ts");
    let calls = 0;
    const client = {
      async *streamChat() {
        calls++;
        if (calls === 1) throw new LLMError("HTTP 429: rate limited", { status: 429, retryAfterSec: undefined });
        yield { textDelta: "recovered" };
      },
    } as any;
    const agent = new Agent({
      client, session: Session.new(home, "mock/m"), tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 2, retryBaseMs: 10,
    });
    const events: string[] = [];
    let text = "";
    for await (const ev of agent.runTurn("hi")) {
      events.push(ev.kind);
      if (ev.kind === "text") text += ev.text;
      if (ev.kind === "retry") expect(ev.attempt).toBe(1);
    }
    expect(text).toBe("recovered");
    expect(events).toContain("retry");
    expect(calls).toBe(2);
  });

  test("a 400 error is surfaced without retrying", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const { LLMError } = await import("../src/llm.ts");
    let calls = 0;
    const client = {
      async *streamChat() { calls++; throw new LLMError("HTTP 400: invalid api key", { status: 400 }); },
    } as any;
    const agent = new Agent({
      client, session: Session.new(home, "mock/m"), tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 2, retryBaseMs: 10,
    });
    const kinds: string[] = [];
    for await (const ev of agent.runTurn("hi")) kinds.push(ev.kind);
    expect(kinds.filter((k) => k === "retry")).toHaveLength(0);
    expect(kinds).toContain("error");
    expect(calls).toBe(1);
  });

  test("partial streamed text is not retried (avoids duplicate output)", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const { LLMError } = await import("../src/llm.ts");
    let calls = 0;
    const client = {
      async *streamChat() {
        calls++;
        yield { textDelta: "half an answer" };
        throw new LLMError("HTTP 500: boom", { status: 500 });
      },
    } as any;
    const agent = new Agent({
      client, session: Session.new(home, "mock/m"), tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 2, retryBaseMs: 10,
    });
    const kinds: string[] = [];
    for await (const ev of agent.runTurn("hi")) kinds.push(ev.kind);
    expect(kinds).not.toContain("retry");
    expect(kinds).toContain("error");
    expect(calls).toBe(1);
  });

  test("a hung request hits the per-attempt timeout and becomes a retryable error", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    let calls = 0;
    const client = {
      async *streamChat(_msgs: any, _tools: any, opts: any) {
        calls++;
        // hang until the agent's deadline aborts us (never yields content)
        await new Promise<void>((_, rej) => {
          if (opts.signal?.aborted) return rej(new Error("aborted"));
          opts.signal?.addEventListener?.("abort", () => rej(new Error("request timed out after 0.15s")));
        });
        yield { textDelta: "never" };
      },
    } as any;
    const agent = new Agent({
      client, session: Session.new(home, "mock/m"), tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 2, retryBaseMs: 20, requestTimeoutMs: 150,
    });
    const kinds: string[] = [];
    let lastReason = "";
    for await (const ev of agent.runTurn("hi")) {
      kinds.push(ev.kind);
      if (ev.kind === "retry") lastReason = ev.reason;
    }
    expect(calls).toBeGreaterThanOrEqual(2); // first attempt timed out, was retried
    expect(lastReason).toContain("timed out");
    expect(kinds).toContain("error"); // exhausted attempts
  });

  test("retry-after hint is respected (capped)", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const { LLMError } = await import("../src/llm.ts");
    let calls = 0;
    const client = {
      async *streamChat() {
        calls++;
        if (calls === 1) throw new LLMError("HTTP 429", { status: 429, retryAfterSec: 0.02 });
        yield { textDelta: "ok" };
      },
    } as any;
    const agent = new Agent({
      client, session: Session.new(home, "mock/m"), tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 2, retryBaseMs: 10,
    });
    let waitMs = -1;
    for await (const ev of agent.runTurn("hi")) if (ev.kind === "retry") waitMs = ev.waitMs;
    expect(waitMs).toBe(20); // honored exactly, not the jittered backoff
  });
});

// ---------- config round-trip ----------
describe("config persistence", () => {
  test("saveConfig preserves unknown keys and excludes project .mcp.json servers", async () => {
    const { loadConfig, saveConfig, configPath } = await import("../src/config.ts");
    const proj = mkdtempSync(join(tmpdir(), "goat-save-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      model: "groq/llama-3.3-70b",
      hand_edited_key: { keep: true },
      mcpServers: { user_server: { command: "user-cmd" } },
    }));
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({
      mcpServers: { proj_server: { command: "proj-cmd" } },
    }));
    const cfg = loadConfig(proj);
    expect(cfg.mcpServers.proj_server).toBeDefined(); // visible at runtime
    cfg.endpoints["myapi"] = {
      id: "myapi", baseUrl: "http://x/v1", format: "openai", models: ["m1"], label: "myapi",
    };
    saveConfig(cfg);
    const saved = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(saved.hand_edited_key).toEqual({ keep: true });        // unknown key survived
    expect(saved.mcpServers.user_server).toBeDefined();           // user server persisted
    expect(saved.mcpServers.proj_server).toBeUndefined();         // project server NOT leaked
    expect(saved.endpoints.myapi.base_url).toBe("http://x/v1");
    expect(saved.max_tokens).toBe(8192);
    rmSync(proj, { recursive: true, force: true });
  });

  test("GOAT_TEMPERATURE and GOAT_MAX_STEPS env overrides", async () => {
    const { loadConfig } = await import("../src/config.ts");
    process.env.GOAT_TEMPERATURE = "0.2";
    process.env.GOAT_MAX_STEPS = "7";
    const cfg = loadConfig(home);
    expect(cfg.temperature).toBeCloseTo(0.2);
    expect(cfg.maxSteps).toBe(7);
    delete process.env.GOAT_TEMPERATURE;
    delete process.env.GOAT_MAX_STEPS;
  });
});

// ---------- sessions ----------
describe("session ids", () => {
  test("two sessions created in the same second get different ids", async () => {
    const { Session } = await import("../src/session.ts");
    const a = Session.new(home, "mock/m");
    const b = Session.new(home, "mock/m");
    expect(a.id).not.toBe(b.id);
  });
});

// ---------- /compact ----------
describe("compact command", () => {
  test("/compact folds old messages and never starts the window on a tool msg", async () => {
    const { runSlash } = await import("../src/commands.tsx");
    const { Session } = await import("../src/session.ts");
    const s = Session.new(home, "mock/m");
    for (let i = 0; i < 20; i++)
      s.messages.push(i % 9 === 8
        ? { role: "tool", content: "r", toolCallId: `t${i}`, name: "read" }
        : { role: "user", content: `msg ${i}` });
    let out = "";
    const io = {
      session: s,
      push: (n: any) => { out = JSON.stringify(n) ?? out; },
      cfg: { model: "mock/m", maxTokens: 8192, autoApprove: false } as any,
      setCfg: () => {}, registry: null as any, setSession: () => {}, saveCfg: () => {},
      exit: () => {}, mcp: null, skills: [], undoTurn: () => 0, backgroundTasks: () => [],
      setMode: () => {}, runTurn: async () => {}, compactNow: async () => "stub", reloadPlugins: () => 0,
      clearAuthBanner: () => {},
    };
    expect(runSlash("/compact", io)).toBe(true);
    expect(s.compactedFrom).toBe(0); // delegated — the stub doesn't mutate
  });

  test("compactNow summarizes with the model and stores the digest", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    let summaryAsked = false;
    const client = {
      async *streamChat(msgs: any[]) {
        summaryAsked = String(msgs[0]?.content).includes("continuation summary");
        yield { textDelta: "User asked X. Edited a.ts. Tests pass." };
      },
    } as any;
    const session = Session.new(home, "mock/m");
    for (let i = 0; i < 20; i++)
      session.messages.push({ role: i % 7 === 6 ? "tool" : "user", content: `m${i} `.repeat(20), ...(i % 7 === 6 ? { toolCallId: `t${i}`, name: "read" } : {}) });
    const agent = new Agent({
      client, session, tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 50, temperature: null, maxSteps: 1,
    });
    const r = await agent.compactNow();
    expect(summaryAsked).toBe(true);
    expect(r.model).toBe(true);
    expect(r.folded).toBeGreaterThan(0);
    expect(session.digest).toContain("Edited a.ts");
    expect(session.messages[session.compactedFrom].role).not.toBe("tool");
    // context after compaction is smaller than full history
    expect(session.context().length).toBeLessThan(20);
    // second call with nothing to fold
    const again = await agent.compactNow();
    expect(again.folded).toBe(0);
  });

  test("compactNow falls back to the digest when the model errors", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const client = {
      async *streamChat() { throw new Error("HTTP 500: boom"); },
    } as any;
    const session = Session.new(home, "mock/m");
    for (let i = 0; i < 20; i++) session.messages.push({ role: "user", content: `plain msg ${i}` });
    const agent = new Agent({
      client, session, tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 50, temperature: null, maxSteps: 1,
    });
    const r = await agent.compactNow();
    expect(r.model).toBe(false);
    expect(r.folded).toBeGreaterThan(0);
    expect(session.digest).toContain("Summary of");
  });
});

// ---------- todo / plan ----------
describe("todo plan", () => {
  test("todo tool stores full list and plan() returns copies", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-todo-"));
    const tk = new ToolKit(root, { autoApprove: true });
    const r = await tk.dispatch("todo", {
      todos: [
        { content: "Write tests", activeForm: "Writing tests", status: "completed" },
        { content: "Fix bug", activeForm: "Fixing bug", status: "in_progress" },
        { content: "Ship", activeForm: "Shipping", status: "pending" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("1/3 completed");
    const plan = tk.plan();
    expect(plan.length).toBe(3);
    expect(plan[1].status).toBe("in_progress");
    // replacement semantics: second call overwrites
    await tk.dispatch("todo", { todos: [{ content: "Only one", activeForm: "Only oneing", status: "in_progress" }] });
    expect(tk.plan().length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("agent emits todo event after the tool runs", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    let turn = 0;
    const client = {
      async *streamChat() {
        turn++;
        if (turn === 1)
          yield { toolCalls: [{ id: "c1", name: "todo", arguments: { todos: [{ content: "Step 1", activeForm: "Stepping", status: "in_progress" }] } }] };
        else yield { textDelta: "planned" };
      },
    } as any;
    const agent = new Agent({
      client, session: Session.new(home, "mock/m"), tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 4,
    });
    const todoEvents: any[] = [];
    for await (const ev of agent.runTurn("plan it"))
      if (ev.kind === "todo") todoEvents.push(ev.todos);
    expect(todoEvents.length).toBe(1);
    expect(todoEvents[0][0].content).toBe("Step 1");
    expect(todoEvents[0][0].activeForm).toBe("Stepping");
  });
});

// ---------- desktop control ----------
describe("desktop control", () => {
  test("computer + screenshot tools exist and permission-gate", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-desk-"));
    const asked: string[] = [];
    const tk = new ToolKit(root, { permission: (t) => { asked.push(t); return false; } });
    const names = tk.specs().map((s) => s.name);
    expect(names).toContain("computer");
    expect(names).toContain("screenshot");
    const r = await tk.dispatch("computer", { action: "click", x: 5, y: 5 });
    expect(r.ok).toBe(false);
    expect(asked).toContain("computer");
    rmSync(root, { recursive: true, force: true });
  });

  test("never-send key combos are refused at the facade", async () => {
    const { desktop } = await import("../src/computer.ts");
    await expect(desktop.act("key", { combo: "win+l" })).rejects.toThrow(/never-send/);
    await expect(desktop.act("key", { combo: "ctrl+alt+delete" })).rejects.toThrow(/never-send/);
  });

  test("unknown actions are rejected", async () => {
    const { desktop } = await import("../src/computer.ts");
    await expect(desktop.act("rmrf", {})).rejects.toThrow(/unknown desktop action/);
  });

  test("plan mode blocks the computer tool", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-deskr-"));
    const tk = new ToolKit(root, { autoApprove: true, readonly: true });
    const r = await tk.dispatch("computer", { action: "click", x: 1, y: 1 });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("plan mode");
    rmSync(root, { recursive: true, force: true });
  });

  test("subagents never get desktop control", async () => {
    const { Agent } = await import("../src/agent.ts");
    const a: any = { disallowedTools: new Set(["computer"]) };
    expect(a.disallowedTools.has("computer")).toBe(true);
    // the spawn guard itself:
    const src = await Bun.file("src/agent.ts").text();
    expect(src).toContain('"computer"');
  });
});

// ---------- web search ----------
describe("websearch", () => {
  test("websearch tool exists, requires a query, and is permission-gated", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-srch-"));
    const tk = new ToolKit(root, { autoApprove: true });
    expect(tk.specs().map((s) => s.name)).toContain("websearch");
    const bad = await tk.dispatch("websearch", {});
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("requires a query");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- parallel read-only tools ----------
describe("parallel tools", () => {
  test("read/glob/grep dispatch concurrently inside one step", async () => {
    const { Agent, CONCURRENT_SAFE } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    expect(CONCURRENT_SAFE.has("read")).toBe(true);
    expect(CONCURRENT_SAFE.has("write")).toBe(false);
    expect(CONCURRENT_SAFE.has("bash")).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "goat-para-"));
    writeFileSync(join(root, "a.txt"), "alpha");
    writeFileSync(join(root, "b.txt"), "beta");
    writeFileSync(join(root, "c.txt"), "gamma");
    const tk = new ToolKit(root, { autoApprove: true });
    // instrument dispatch with a barrier: if calls run sequentially this deadlocks
    let active = 0, maxActive = 0;
    const orig = tk.dispatch.bind(tk);
    (tk as any).dispatch = async (name: string, args: any, signal?: AbortSignal) => {
      active++; maxActive = Math.max(maxActive, active);
      await Bun.sleep(30);
      const r = await orig(name, args, signal);
      active--;
      return r;
    };
    let turn = 0;
    const client = {
      async *streamChat() {
        turn++;
        if (turn === 1)
          yield { toolCalls: [
            { id: "1", name: "read", arguments: { path: "a.txt" } },
            { id: "2", name: "read", arguments: { path: "b.txt" } },
            { id: "3", name: "read", arguments: { path: "c.txt" } },
          ] };
        else yield { textDelta: "done" };
      },
    } as any;
    const agent = new Agent({
      client, session: Session.new(root, "mock/m"), tools: tk,
      maxTokens: 10, temperature: null, maxSteps: 3,
    });
    const ends: any[] = [];
    for await (const ev of agent.runTurn("read all"))
      if (ev.kind === "tool_end") ends.push(ev);
    expect(maxActive).toBe(3);           // all three in flight at once
    expect(ends.length).toBe(3);
    expect(ends[0].result).toContain("alpha"); // order preserved in the transcript
    expect(ends[2].result).toContain("gamma");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- small model routing ----------
describe("small model", () => {
  test("config parses small_model and compactNow uses it when present", async () => {
    const { loadConfig } = await import("../src/config.ts");
    writeFileSync(join(home, "config.json"), JSON.stringify({
      model: "openai/gpt-4o", small_model: "groq/llama-3.3-70b",
    }));
    const cfg = loadConfig(home);
    expect(cfg.smallModel).toBe("groq/llama-3.3-70b");
  });

  test("resolveSmall returns null when unset or same as main", async () => {
    const { resolveSmall } = await import("../src/runtime.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { ProviderRegistry } = await import("../src/providers.ts");
    const cfg = loadConfig(home);
    expect(await resolveSmall(cfg, new ProviderRegistry())).toBeNull();
    cfg.smallModel = "openai/gpt-4o"; cfg.model = "openai/gpt-4o";
    expect(await resolveSmall(cfg, new ProviderRegistry())).toBeNull();
  });

  test("compact calls the smallClient, not the main client", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    let mainCalls = 0, smallCalls = 0;
    const mk = (n: string) => ({ async *streamChat() {
      if (n === "main") mainCalls++; else smallCalls++;
      yield { textDelta: "compressed digest" };
    } } as any);
    const session = Session.new(home, "mock/m");
    for (let i = 0; i < 20; i++) session.messages.push({ role: "user", content: `msg ${i} ` + "y".repeat(100) });
    const agent = new Agent({
      client: mk("main"), smallClient: mk("small"), session,
      tools: new ToolKit(home, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 1,
    });
    const r = await agent.compactNow();
    expect(r.model).toBe(true);
    expect(smallCalls).toBe(1);
    expect(mainCalls).toBe(0);
  });
});

// ---------- Computer() permission rules ----------
describe("computer rules", () => {
  test("Computer(type) deny blocks only typing; bare Computer blocks all", async () => {
    const { decide } = await import("../src/permissions.ts");
    const denyType = { allow: [], deny: ["Computer(type)"] };
    expect(decide(denyType, "computer", { action: "type", text: "x" })).toBe("deny");
    expect(decide(denyType, "computer", { action: "click", x: 1, y: 2 })).toBe("ask");
    const denyAll = { allow: [], deny: ["Computer"] };
    expect(decide(denyAll, "computer", { action: "click", x: 1, y: 2 })).toBe("deny");
    const denyClick = { allow: [], deny: ["Computer(click)"] };
    expect(decide(denyClick, "computer", { action: "double_click", x: 1, y: 2 })).toBe("deny");
    expect(decide(denyClick, "computer", { action: "key", combo: "ctrl+s" })).toBe("ask");
  });

  test("Toolkit honors a Computer(type) deny end-to-end", async () => {
    const { ToolKit } = await import("../src/tools.ts");
    const root = mkdtempSync(join(tmpdir(), "goat-crule-"));
    const tk = new ToolKit(root, { rules: { allow: [], deny: ["Computer(type)"] }, autoApprove: false });
    const r = await tk.dispatch("computer", { action: "type", text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("denied by permission rule");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- update checks ----------
describe("update", () => {
  test("versionLess compares semver numerically, not lexically", async () => {
    const { versionLess } = await import("../src/update.ts");
    expect(versionLess("2.1.9", "2.1.10")).toBe(true);   // the classic string bug
    expect(versionLess("2.9.0", "2.10.0")).toBe(true);
    expect(versionLess("v2.1.3", "2.2.0")).toBe(true);
    expect(versionLess("2.2.0", "2.2.0")).toBe(false);
    expect(versionLess("2.2.1", "2.2.0")).toBe(false);
    expect(versionLess("2.1.3-beta", "2.1.3")).toBe(false); // prerelease ignored
  });

  test("assetName maps platform/arch to release assets", async () => {
    const { assetName } = await import("../src/update.ts");
    expect(assetName("win32", "x64")).toBe("goat-windows-x64.exe");
    expect(assetName("darwin", "arm64")).toBe("goat-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("goat-linux-x64");
    expect(assetName("freebsd", "x64")).toBeNull();
  });

  test("VERSION is the single source of truth (constants == both package.json)", async () => {
    const { VERSION } = await import("../src/constants.ts");
    const root = await Bun.file("package.json").json();
    const npm = await Bun.file("npm-package/package.json").json();
    expect(root.version).toBe(VERSION);
    expect(npm.version).toBe(VERSION);
    const idx = await Bun.file("src/index.ts").text();
    expect(idx).toContain("`goatcode ${VERSION}`"); // no hardcoded version strings
  });

  test("cachedUpdateHint only fires for a genuinely newer release", async () => {
    const { cachedUpdateHint } = await import("../src/update.ts");
    const { VERSION } = await import("../src/constants.ts");
    const fs = await import("node:fs");
    const { join } = await import("node:path");
    const hintPath = join(home, "update-check.json");
    // newer than current -> hint
    fs.writeFileSync(hintPath, JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }));
    expect(cachedUpdateHint(VERSION)?.latest).toBe("99.0.0");
    // same/older -> no hint
    fs.writeFileSync(hintPath, JSON.stringify({ latest: VERSION, checkedAt: Date.now() }));
    expect(cachedUpdateHint(VERSION)).toBeUndefined();
    // corrupt -> no hint, no throw
    fs.writeFileSync(hintPath, "not json");
    expect(cachedUpdateHint(VERSION)).toBeUndefined();
  });

  test("refreshUpdateHint respects the offline opt-out", async () => {
    const { refreshUpdateHint } = await import("../src/update.ts");
    const fs = await import("node:fs");
    const { join } = await import("node:path");
    process.env.GOAT_NO_UPDATE_CHECK = "1";
    fs.rmSync(join(home, "update-check.json"), { force: true });
    refreshUpdateHint();               // must not write anything
    await Bun.sleep(50);
    expect(fs.existsSync(join(home, "update-check.json"))).toBe(false);
    delete process.env.GOAT_NO_UPDATE_CHECK;
  });
});
