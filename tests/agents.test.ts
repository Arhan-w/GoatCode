/**
 * Custom subagent tests — agent .md loading, frontmatter parsing, tool
 * allowlist enforcement in spawnSubagent, and system-prompt integration.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let home: string;
let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "goat-ag-home-"));
  root = mkdtempSync(join(tmpdir(), "goat-ag-root-"));
  savedEnv.GOATCODE_HOME = process.env.GOATCODE_HOME;
  process.env.GOATCODE_HOME = home;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("custom agents", () => {
  test("loader parses frontmatter and skips files without description", async () => {
    const { loadCustomAgents } = await import("../src/agents/loader.ts");
    const dir = mkdtempSync(join(tmpdir(), "goat-agents-"));
    writeFileSync(join(dir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code for bugs and style\ntools: read, grep, glob\n---\n\nYou are a code reviewer. Be terse.\n");
    writeFileSync(join(dir, "notanagent.md"), "just some notes, no frontmatter\n");
    writeFileSync(join(dir, "tester.md"),
      "---\ndescription: Runs the test suite\n---\n\nRun tests. Report failures.\n");
    const agents = loadCustomAgents(dir);
    expect(agents.length).toBe(2);
    const reviewer = agents.find((a) => a.name === "reviewer")!;
    expect(reviewer.description).toBe("Reviews code for bugs and style");
    expect(reviewer.tools).toEqual(["read", "grep", "glob"]);
    expect(reviewer.body).toContain("code reviewer");
    // name defaults to the filename
    expect(agents.find((a) => a.name === "tester")).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("agentDirs includes home, ./agents and ./.goat/agents", async () => {
    const { agentDirs } = await import("../src/agents/loader.ts");
    const dirs = agentDirs(root);
    expect(dirs.length).toBe(3);
    expect(dirs.some((d) => d.includes("agents"))).toBe(true);
  });

  test("spawnSubagent enforces a custom agent's tool allowlist", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    // a custom "reader" agent that may only read/grep — bash must be refused
    const customAgents = [{
      name: "reader",
      description: "read-only research",
      tools: ["read", "grep", "glob"],
      body: "You read files and report.",
      path: "",
    }];

    const seenSpecs: string[][] = [];
    const childToolUses: string[] = [];
    const client = {
      async *streamChat(_msgs: any[], specs: any[]) {
        // child call: the spec list reveals the effective toolset
        seenSpecs.push(specs.map((s: any) => s.name));
        yield { textDelta: "child done" };
      },
    } as any;
    const session = Session.new(root, "mock/m");
    const agent = new Agent({
      client, session, tools: new ToolKit(root, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 3,
      customAgents,
    });
    let parentCalls = 0;
    const origStream = client.streamChat.bind(client);
    client.streamChat = async function* (msgs: any[], specs: any[]) {
      const isChild = msgs.some((m: any) => String(m.content).includes("SUBTASK"));
      if (!isChild) {
        parentCalls++;
        if (parentCalls === 1) yield { toolCalls: [{ id: "t1", name: "task", arguments: { description: "research", prompt: "SUBTASK read it", subagent_type: "reader" } }] };
        else yield { textDelta: "parent done" };
      } else {
        seenSpecs.push(specs.map((s: any) => s.name));
        yield { textDelta: "child done" };
      }
    };
    for await (const _ of agent.runTurn("go read")) void _;

    // child saw a filtered spec list: bash must NOT be present
    const childSpecs = seenSpecs[0];
    expect(childSpecs).not.toContain("bash");
    expect(childSpecs).not.toContain("write");
    expect(childSpecs).toContain("read");
    expect(childSpecs).not.toContain("task"); // custom agents never nest
  });

  test("custom agents appear in the system prompt for subagent_type selection", async () => {
    const { buildSystemPrompt } = await import("../src/system-prompt.ts");
    const p = buildSystemPrompt("/w", ["reviewer: Reviews code (tools: read, grep)"]);
    expect(p).toContain("reviewer: Reviews code");
    expect(p).toContain("Custom subagents available");
    // none configured -> no block
    const plain = buildSystemPrompt("/w");
    expect(plain).not.toContain("Custom subagents available");
  });

  test("project-level agents win name collisions over user-level (docs/AGENTS.md)", async () => {
    const { loadCustomAgents } = await import("../src/agents/loader.ts");
    const projDir = mkdtempSync(join(tmpdir(), "goat-ag-proj-"));
    // "reviewer" defined in both: user says generic, project says specific
    const userDir = join(home, "agents");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "reviewer.md"),
      "---\ndescription: USER-level reviewer\n---\nuser body\n");
    writeFileSync(join(projDir, "reviewer.md"),
      "---\ndescription: PROJECT-level reviewer\n---\nproject body\n");
    // project roots come first in agentDirs -> project wins
    const agents = loadCustomAgents(projDir, userDir);
    expect(agents.length).toBe(1);
    expect(agents[0].description).toBe("PROJECT-level reviewer");
    rmSync(projDir, { recursive: true, force: true });
  });

  test("unknown subagent_type returns a clear error listing available types", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const customAgents = [{ name: "reader", description: "reads", body: "b", path: "" }];
    let childCalls = 0;
    const client = {
      async *streamChat(_msgs: any[], _specs: any[]) {
        childCalls++;
        yield { textDelta: "done" };
      },
    } as any;
    const session = Session.new(root, "mock/m");
    const agent = new Agent({
      client, session, tools: new ToolKit(root, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 4,
      customAgents,
    });
    let parentCalls = 0;
    client.streamChat = async function* (msgs: any[], specs: any[]) {
      const isChild = msgs.some((m: any) => String(m.content).includes("SUBTASK"));
      if (!isChild) {
        parentCalls++;
        if (parentCalls === 1)
          yield { toolCalls: [{ id: "t1", name: "task", arguments: { description: "x", prompt: "SUBTASK go", subagent_type: "nonexistent" } }] };
        else yield { textDelta: "parent done" };
      } else {
        childCalls++;
        yield { textDelta: "child done" };
      }
    };
    for await (const _ of agent.runTurn("go")) void _;
    // no child ran; the tool result explains what's available
    const toolMsg = session.messages.find((m) => m.role === "tool" && m.name === "task");
    expect(String(toolMsg?.content)).toContain("unknown subagent_type");
    expect(String(toolMsg?.content)).toContain("reader");
    expect(childCalls).toBe(0);
  });

  test("general subagents run with full tools; custom allowlist can include write", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    // custom "builder" agent explicitly allowed write
    const customAgents = [{
      name: "builder",
      description: "builds files",
      tools: ["read", "write", "bash"],
      body: "You build.",
      path: "",
    }];
    const childSpecs: string[][] = [];
    const client = {
      async *streamChat(_msgs: any[], _specs: any[]) { yield { textDelta: "x" }; },
    } as any;
    const session = Session.new(root, "mock/m");
    const agent = new Agent({
      client, session, tools: new ToolKit(root, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 4,
      customAgents,
    });
    let parentCalls = 0;
    client.streamChat = async function* (msgs: any[], specs: any[]) {
      const isChild = msgs.some((m: any) => String(m.content).includes("SUBTASK"));
      if (!isChild) {
        parentCalls++;
        if (parentCalls === 1)
          yield { toolCalls: [{ id: "t1", name: "task", arguments: { description: "x", prompt: "SUBTASK build", subagent_type: "builder" } }] };
        else yield { textDelta: "done" };
      } else {
        childSpecs.push(specs.map((s: any) => s.name));
        yield { textDelta: "child done" };
      }
    };
    for await (const _ of agent.runTurn("go")) void _;
    const specs = childSpecs[0];
    // allowlisted tools present (write explicitly granted), task/undo never
    expect(specs).toContain("write");
    expect(specs).toContain("read");
    expect(specs).toContain("bash");
    expect(specs).not.toContain("task");
    expect(specs).not.toContain("undo");
  });

  test("custom agent model override resolves through resolveClientFor", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { Session } = await import("../src/session.ts");
    const { ToolKit } = await import("../src/tools.ts");
    const customAgents = [{
      name: "cheap",
      description: "runs cheap",
      model: "other/mini",
      body: "cheap body",
      path: "",
    }];
    let overrideModel = "";
    const client = { async *streamChat() { yield { textDelta: "x" }; } } as any;
    const session = Session.new(root, "mock/m");
    const agent = new Agent({
      client, session, tools: new ToolKit(root, { autoApprove: true }),
      maxTokens: 10, temperature: null, maxSteps: 4,
      customAgents,
      resolveClientFor: async (model) => {
        overrideModel = model;
        return { async *streamChat() { yield { textDelta: "from override client" }; } } as any;
      },
    });
    let parentCalls = 0;
    client.streamChat = async function* (msgs: any[]) {
      const isChild = msgs.some((m: any) => String(m.content).includes("SUBTASK"));
      if (!isChild) {
        parentCalls++;
        if (parentCalls === 1)
          yield { toolCalls: [{ id: "t1", name: "task", arguments: { description: "x", prompt: "SUBTASK cheap", subagent_type: "cheap" } }] };
        else yield { textDelta: "done" };
      } else {
        yield { textDelta: "child done" };
      }
    };
    for await (const _ of agent.runTurn("go")) void _;
    expect(overrideModel).toBe("other/mini");
  });
});
