/**
 * The agent loop: prompt -> stream -> tool calls -> results -> repeat.
 * Model-agnostic: one ChatClient interface (from llm.make_client) behind
 * every provider. Events are yielded so the UI can render incrementally.
 */
import { buildSystemPrompt } from "./system-prompt.ts";
import type { ChatClient, Message, StreamEvent, ToolCall, ToolSpec } from "./llm.ts";
import { Session } from "./session.ts";
import { ToolKit, type PermissionFn } from "./tools.ts";

export const COMPACT_TRIGGER_CHARS = 220_000;

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_start"; tool: string; args: Record<string, unknown> }
  | { kind: "tool_end"; tool: string; result: string; ok: boolean }
  | { kind: "usage"; text: string }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }
  | { kind: "error"; text: string }
  | { kind: "done" };

export interface AgentDeps {
  client: ChatClient;
  session: Session;
  tools: ToolKit;
  maxTokens: number;
  temperature: number | null;
  maxSteps: number;
  /** Extra system context: skills list, GOAT.md, MCP notes. */
  extraSystem?: string;
}

export class Agent {
  client: ChatClient;
  session: Session;
  tools: ToolKit;
  maxTokens: number;
  temperature: number | null;
  maxSteps: number;
  extraSystem: string;

  constructor(deps: AgentDeps) {
    this.client = deps.client;
    this.session = deps.session;
    this.tools = deps.tools;
    this.maxTokens = deps.maxTokens;
    this.temperature = deps.temperature;
    this.maxSteps = deps.maxSteps;
    this.extraSystem = deps.extraSystem ?? "";
  }

  private messages(): Message[] {
    const ctx = this.session.context();
    let sys = buildSystemPrompt(this.session.cwd);
    if (this.extraSystem) sys += "\n\n" + this.extraSystem;
    const msgs: Message[] = [{ role: "system", content: sys }];
    if (this.session.compactedFrom > 0)
      msgs.push({ role: "system", content: "[previous conversation compacted]" });
    msgs.push(...ctx);
    return msgs;
  }

  async *runTurn(userText: string): AsyncGenerator<AgentEvent> {
    this.session.append({ role: "user", content: userText });
    if (!this.session.title)
      this.session.title = userText.trim().split("\n")[0]?.slice(0, 80) ?? "session";
    let steps = 0;
    while (steps < this.maxSteps) {
      steps += 1;
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      for await (const ev of this.streamOnce()) {
        if (ev.kind === "error") { yield ev; return; }
        if (ev.kind === "text") { assistantText += ev.text; yield ev; }
        else if (ev.kind === "usage") yield ev;
        else if (ev.kind === "tool_calls") toolCalls.push(...ev.toolCalls);
      }
      if (!toolCalls.length) {
        this.session.append({ role: "assistant", content: assistantText });
        this.session.save();
        yield { kind: "done" };
        return;
      }
      const assistantMsg: Message & { toolCalls: ToolCall[] } = {
        role: "assistant", content: assistantText, toolCalls,
      };
      this.session.append(assistantMsg as Message);
      for (const call of toolCalls) {
        yield { kind: "tool_start", tool: call.name, args: call.arguments };
        const result = await this.tools.dispatch(call.name, call.arguments);
        this.session.append({
          role: "tool", content: result.output.slice(0, 60_000),
          toolCallId: call.id, name: call.name,
        });
        yield { kind: "tool_end", tool: call.name, result: result.output.slice(0, 2000), ok: result.ok };
      }
      this.maybeCompact();
      this.session.save();
    }
    yield { kind: "error", text: `stopped after ${this.maxSteps} steps` };
  }

  private async *streamOnce(): AsyncGenerator<AgentEvent> {
    try {
      for await (const ev of this.client.streamChat(
        this.messages(), this.tools.specs(),
        { model: modelId(this.session.model), maxTokens: this.maxTokens, temperature: this.temperature },
      )) {
        if (ev.textDelta) yield { kind: "text", text: ev.textDelta };
        else if (ev.usage) yield { kind: "usage", text: `${ev.usage.prompt}+${ev.usage.completion} tok` };
        else if (ev.toolCalls) yield { kind: "tool_calls", toolCalls: ev.toolCalls };
        else if (ev.error) yield { kind: "error", text: ev.error };
      }
    } catch (e: any) {
      yield { kind: "error", text: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
    }
  }

  private maybeCompact(): void {
    const total = this.session.messages.reduce((s, m) => s + m.content.length, 0);
    if (total > COMPACT_TRIGGER_CHARS && this.session.messages.length > 12) {
      const keep = Math.max(8, Math.floor(this.session.messages.length / 3));
      let cut = this.session.messages.length - keep;
      while (cut < this.session.messages.length && this.session.messages[cut]?.role === "tool") cut++;
      if (cut < this.session.messages.length) this.session.compactedFrom = cut;
    }
  }
}

export function buildSystemPrompt(cwd: string): string {
  return `You are GoatCode, a precise terminal coding agent running on the user's machine.

Rules:
- Act on the request; don't restate it. Show conclusions through tool results, not narration.
- Prefer read/grep/glob before editing. Never guess file contents.
- edit requires an exact unique old_string. If it fails, read the file and retry.
- Keep bash commands non-interactive. Quote paths with spaces.
- When done, give a 1-3 line summary: what changed, what to verify.
- If the task is ambiguous and risky (deletes, pushes, money), ask first.

Environment:
- Working directory: ${cwd}
- Platform: ${process.platform}
`;
}

export function modelId(sessionModel: string): string {
  const i = sessionModel.indexOf("/");
  return i > 0 ? sessionModel.slice(i + 1) : sessionModel;
}
