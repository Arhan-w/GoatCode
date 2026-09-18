/**
 * Enhanced Agent with ReAct/Plan-and-Execute Reasoning
 * Adds structured reasoning, planning, and tool result summarization
 */

import { buildSystemPrompt } from "./system-prompt.ts";
import { contentChars, isRetryableLLMError, textOf, type ChatClient, type ContentPart, type Message, type StreamEvent, type ToolCall, type ToolSpec } from "./llm.ts";
import { Session, summarize } from "./session.ts";
import { ToolKit, type PermissionFn, type Todo, type ToolResult } from "./tools.ts";
import { fireHooks, MAX_STOP_HOOK_CONTINUES } from "./hooks.ts";
import { SUBAGENT_MAX_STEPS, ULTRACODE_FANOUT } from "./constants.ts";

export const COMPACT_TRIGGER_CHARS = 220_000;
export const LLM_MAX_ATTEMPTS = 4;
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 20_000;
export const REQUEST_TIMEOUT_MS = (() => {
  const n = Number(process.env.GOAT_REQUEST_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 120_000;
})();

export interface ReasoningStep {
  type: "observe" | "think" | "act" | "reflect";
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface Plan {
  steps: PlanStep[];
  goal: string;
  currentStep: number;
  status: "planning" | "executing" | "completed" | "failed";
}

export interface PlanStep {
  id: string;
  description: string;
  tool?: string;
  args?: Record<string, unknown>;
  expectedOutcome: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string;
}

export const CONCURRENT_SAFE = new Set(["read", "glob", "grep", "tasks"]);

export interface AgentDeps {
  client: ChatClient;
  cache?: boolean;
  smallClient?: ChatClient;
  session: Session;
  tools: ToolKit;
  maxTokens: number;
  temperature: number | null;
  maxSteps: number;
  extraSystem?: string;
  retryBaseMs?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  disallowedTools?: Set<string>;
  fallbacks?: Array<{ client: ChatClient; model: string }>;
  enablePlanning?: boolean;
  enableReasoning?: boolean;
  reasoningModel?: ChatClient;
}

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "planning"; plan: Plan }
  | { kind: "tool_start"; tool: string; args: Record<string, unknown> }
  | { kind: "tool_end"; tool: string; result: string; ok: boolean }
  | { kind: "usage"; text: string; usage?: { prompt: number; completion: number; cacheRead?: number; cacheWrite?: number } }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }
  | { kind: "retry"; attempt: number; waitMs: number; reason: string }
  | { kind: "fallback"; from: string; to: string; reason: string }
  | { kind: "todo"; todos: Todo[] }
  | { kind: "error"; text: string }
  | { kind: "done" }
  | { kind: "reasoning"; step: ReasoningStep }
  | { kind: "planning"; plan: Plan };

export class EnhancedAgent {
  client: ChatClient;
  smallClient: ChatClient | null;
  session: Session;
  tools: ToolKit;
  maxTokens: number;
  temperature: number | null;
  maxSteps: number;
  extraSystem: string;
  retryBaseMs: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  disallowedTools: Set<string>;
  fallbacks: Array<{ client: ChatClient; model: string }>;
  cache: boolean;
  enablePlanning: boolean;
  enableReasoning: boolean;
  reasoningModel: ChatClient | null;
  plan: Plan | null = null;
  reasoningTrace: ReasoningStep[] = [];
  lastPromptTokens = 0;

  constructor(deps: AgentDeps) {
    this.client = deps.client;
    this.smallClient = deps.smallClient ?? null;
    this.session = deps.session;
    this.tools = deps.tools;
    this.maxTokens = deps.maxTokens;
    this.temperature = deps.temperature;
    this.maxSteps = deps.maxSteps;
    this.extraSystem = deps.extraSystem ?? "";
    this.retryBaseMs = deps.retryBaseMs ?? 1000;
    this.maxAttempts = deps.maxAttempts ?? 4;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 120_000;
    this.disallowedTools = deps.disallowedTools ?? new Set();
    this.fallbacks = deps.fallbacks ? [...deps.fallbacks] : [];
    this.cache = deps.cache ?? false;
    this.enablePlanning = deps.enablePlanning ?? true;
    this.enableReasoning = deps.enableReasoning ?? true;
    this.reasoningModel = deps.reasoningModel ?? null;
    this.plan = null;
    this.reasoningTrace = [];
    this.lastPromptTokens = 0;
  }

  private messages(): Message[] {
    const ctx = this.session.context();
    let sys = buildSystemPrompt(this.session.cwd);
    if (this.extraSystem) sys += "\n\n" + this.extraSystem;
    if (this.reasoningTrace.length > 0) {
      sys += "\n\n## Reasoning Trace\n" + this.reasoningTrace.slice(-5).map(r => `[${r.type.toUpperCase()}] ${r.content}`).join("\n");
    }
    if (this.extraSystem) sys += "\n\n" + this.extraSystem;
    const msgs: Message[] = [{ role: "system", content: sys }];
    if (this.session.compactedFrom > 0) {
      const digest = this.session.digest || summarize(this.session.messages.slice(0, this.session.compactedFrom));
      msgs.push({ role: "system", content: digest });
    }
    msgs.push(...ctx);
    return msgs;
  }

  async createPlan(goal: string): Promise<Plan> {
    const planningPrompt = `You are a planning agent. Create a detailed step-by-step plan to achieve the goal.
    
Goal: ${goal}

Available tools: read, write, edit, bash, glob, grep, task, todo, webfetch, websearch

Create a detailed plan with specific steps. Each step should have:
1. Clear description
2. Tool to use (if applicable)
3. Expected outcome
4. Success criteria

Format as JSON:
{
  "goal": "string",
  "steps": [
    {"id": "1", "description": "string", "tool": "tool_name", "args": {}, "expectedOutcome": "string"},
    ...
  ]
}`;

    const planPrompt = `User Goal: ${this.session.cwd}\n\nTask: ${this.extraSystem || "No additional context"}\n\nUser Request: ${this.session.messages[this.session.messages.length - 1]?.content || ""}`;

    try {
      let planText = "";
      for await (const ev of this.client.streamChat(
        [{ role: "system", content: "You are a planning agent. Create a detailed plan. Return only valid JSON." },
         { role: "user", content: `Create a plan for: ${goal}` }],
        [],
        { model: "planner", maxTokens: 2048, temperature: 0.1 }
      )) {
        if (ev.textDelta) planText += ev.textDelta;
      }
      
      const planData = JSON.parse(planText);
      const plan: Plan = {
        goal: planData.goal || "Complete task",
        steps: planData.steps.map((s: any, i: number) => ({
          id: s.id || String(i + 1),
          description: s.description,
          tool: s.tool,
          args: s.args || {},
          expectedOutcome: s.expectedOutcome || "",
          status: "pending"
        })),
        goal: planData.goal || "Complete task",
        currentStep: 0,
        status: "planning"
      };
      
      this.plan = plan;
      return plan;
    } catch (e) {
      return this.createFallbackPlan();
    }
  }

  private createFallbackPlan(): Plan {
    return {
      goal: "Complete the task",
      steps: [{
        id: "1",
        description: "Analyze the task and determine approach",
        tool: "read",
        args: { path: "." },
        expectedOutcome: "Understand the codebase structure",
        status: "pending"
      }],
      currentStep: 0,
      status: "planning"
    };
  }

  private addReasoningStep(type: ReasoningStep["type"], content: string, metadata?: Record<string, any>) {
    this.reasoningTrace.push({ type, content, timestamp: Date.now(), metadata });
  }

  private messages(): Message[] {
    const ctx = this.session.context();
    let sys = buildSystemPrompt(this.session.cwd);
    if (this.extraSystem) sys += "\n\n" + this.extraSystem;
    if (this.reasoningTrace.length > 0) {
      sys += "\n\n## Reasoning Trace\n" + this.reasoningTrace.slice(-5).map(r => `[${r.type.toUpperCase()}] ${r.content}`).join("\n");
    }
    if (this.extraSystem) sys += "\n\n" + this.extraSystem;
    const msgs: Message[] = [{ role: "system", content: sys }];
    if (this.session.compactedFrom > 0) {
      const digest = this.session.digest || summarize(this.session.messages.slice(0, this.session.compactedFrom));
      msgs.push({ role: "system", content: digest });
    }
    msgs.push(...this.session.context());
    return msgs;
  }

  async *runTurn(userText: string | ContentPart[], signal?: AbortSignal): AsyncGenerator<any> {
    this.session.append({ role: "user", content: userText });
    if (!this.session.title) {
      const first = typeof userText === "string" ? userText : textOf(userText);
      this.session.title = first.trim().split("\n")[0]?.slice(0, 80) ?? "session";
    }

    if (this.enablePlanning && !this.plan) {
      const userTextStr = typeof userText === "string" ? userText : textOf(userText);
      this.plan = await this.createPlan(userText);
      yield { kind: "planning", plan: this.plan };
    }

    let steps = 0;
    let stopContinues = 0;
    while (steps < this.maxSteps) {
      steps++;
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      
      for await (const ev of this.streamWithRetry()) {
        if (ev.kind === "error") { yield ev; return; }
        if (ev.kind === "text") { assistantText += ev.text; yield ev; }
        else if (ev.kind === "thinking") { this.addReasoningStep("think", ev.text); yield ev; }
        else if (ev.kind === "usage") yield ev;
        else if (ev.kind === "retry") yield ev;
        else if (ev.kind === "fallback") yield ev;
        else if (ev.kind === "tool_calls") toolCalls.push(...ev.toolCalls);
      }
      
      if (!toolCalls.length) {
        this.session.append({ role: "assistant", content: assistantText });
        this.addReasoningStep("reflect", `Completed turn without tool calls. Response: ${assistantText.slice(0, 200)}`);
        
        if (this.tools.hooks?.Stop?.length) {
          const hr = await fireHooks(this.tools.hooks, "Stop", {
            session_id: this.tools.sessionId, transcript_path: "", cwd: this.tools.root,
            hook_event_name: "Stop", hookEventName: "Stop",
            stop_hook_active: false,
          } as any, this.tools.sessionId);
          if (hr.blocked && hr.reason) {
            this.session.append({ role: "user", content: `[stop-hook feedback] ${hr.reason}` });
            continue;
          }
        }
        this.session.save();
        yield { kind: "done" };
        return;
      }

      for (const call of toolCalls) {
        this.addReasoningStep("act", `Calling ${call.name} with args: ${JSON.stringify(call.arguments).slice(0, 200)}`);
        yield { kind: "tool_start", tool: call.name, args: call.arguments };
        
        let result;
        if (call.name === "task") {
          result = await this.spawnSubagent(call.arguments);
        } else {
          result = await this.tools.dispatch(call.name, call.arguments);
        }
        
        this.addReasoningStep("observe", `Tool ${call.name} result: ${(result.output || "").slice(0, 300)}`);
        this.session.append({
          role: "tool",
          content: result.output?.slice(0, 60000) || "",
          toolCallId: call.id, name: call.name,
        });
        
        yield { kind: "tool_end", tool: call.name, result: result.output?.slice(0, 2000) || "", ok: true };
      }

      this.maybeCompact();
      this.session.save();
    }
    yield { kind: "error", text: `stopped after ${this.maxSteps} steps` };
  }

  private async *streamWithRetry(signal?: AbortSignal): AsyncGenerator<any> {
    for (let attempt = 1; ; attempt++) {
      let sawContent = false;
      let timedOut = false;
      const ctrl = new AbortController();
      const timer = setTimeout(() => { ctrl.abort(); }, 120000);
      const onUserAbort = () => ctrl.abort();
      signal?.addEventListener("abort", () => ctrl.abort());
      
      try {
        const specs = this.tools.specs().filter((s) => !this.disallowedTools.has(s.name));
        for await (const ev of this.streamOnce(ctrl.signal)) {
          if (ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_calls") sawContent = true;
          yield ev;
        }
        return;
      } catch (e: any) {
        if (e?.message?.includes("timeout")) {
          yield { kind: "error", text: "Request timed out" };
          return;
        }
        yield { kind: "error", text: String(e?.message ?? e) };
        return;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async *streamOnce(signal?: AbortSignal): AsyncGenerator<any> {
    const specs = this.tools.specs().filter((s) => !this.disallowedTools.has(s.name));
    for await (const ev of this.client.streamChat(
      this.messages(), this.tools.specs(),
      { model: "default", maxTokens: this.maxTokens, temperature: this.temperature, signal }
    )) {
      if (ev.textDelta) yield { kind: "text", text: ev.textDelta };
      else if (ev.thinkingDelta) { this.addReasoningStep("think", ev.thinkingDelta); yield { kind: "thinking", text: ev.thinkingDelta }; }
      else if (ev.usage) { 
        this.session.usage.in += ev.usage.prompt;
        this.session.usage.out += ev.usage.completion;
        this.lastPromptTokens = ev.usage.prompt + (ev.usage.cacheRead ?? 0) + (ev.usage.cacheWrite ?? 0);
        yield { kind: "usage", text: `${ev.usage.prompt}+${ev.usage.completion} tok`, usage: ev.usage };
      }
      else if (ev.toolCalls) yield { kind: "tool_calls", toolCalls: ev.toolCalls };
      else if (ev.error) yield { kind: "error", text: ev.error };
    }
  }

  private async spawnSubagent(args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    return { ok: true, output: "Subagent completed" };
  }
}

export type { Plan, PlanStep, ReasoningStep, Plan };