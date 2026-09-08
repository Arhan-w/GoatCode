/**
 * The agent loop: prompt -> stream -> tool calls -> results -> repeat.
 * Model-agnostic: one ChatClient interface (from llm.make_client) behind
 * every provider. Events are yielded so the UI can render incrementally.
 */
import { buildSystemPrompt } from "./system-prompt.ts";
import { isRetryableLLMError, type ChatClient, type Message, type StreamEvent, type ToolCall, type ToolSpec } from "./llm.ts";
import { Session, summarize } from "./session.ts";
import { ToolKit, type PermissionFn } from "./tools.ts";

export const COMPACT_TRIGGER_CHARS = 220_000;
/** Attempt budget for transient LLM failures (429/5xx/network) within one step. */
export const LLM_MAX_ATTEMPTS = 4;
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 20_000;
/** Per-attempt wall clock: a provider that hangs gets cut off and retried. */
export const REQUEST_TIMEOUT_MS = (() => {
  const n = Number(process.env.GOAT_REQUEST_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 120_000;
})();

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_start"; tool: string; args: Record<string, unknown> }
  | { kind: "tool_end"; tool: string; result: string; ok: boolean }
  | { kind: "usage"; text: string; usage?: { prompt: number; completion: number } }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }
  | { kind: "retry"; attempt: number; waitMs: number; reason: string }
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
  /** Retry tuning (tests shrink these; production uses the exported defaults). */
  retryBaseMs?: number;
  maxAttempts?: number;
  /** Per-attempt request deadline in ms (default REQUEST_TIMEOUT_MS). */
  requestTimeoutMs?: number;
}

export class Agent {
  client: ChatClient;
  session: Session;
  tools: ToolKit;
  maxTokens: number;
  temperature: number | null;
  maxSteps: number;
  extraSystem: string;
  retryBaseMs: number;
  maxAttempts: number;
  requestTimeoutMs: number;

  constructor(deps: AgentDeps) {
    this.client = deps.client;
    this.session = deps.session;
    this.tools = deps.tools;
    this.maxTokens = deps.maxTokens;
    this.temperature = deps.temperature;
    this.maxSteps = deps.maxSteps;
    this.extraSystem = deps.extraSystem ?? "";
    this.retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    this.maxAttempts = deps.maxAttempts ?? LLM_MAX_ATTEMPTS;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private messages(): Message[] {
    const ctx = this.session.context();
    let sys = buildSystemPrompt(this.session.cwd);
    if (this.extraSystem) sys += "\n\n" + this.extraSystem;
    const msgs: Message[] = [{ role: "system", content: sys }];
    if (this.session.compactedFrom > 0)
      msgs.push({ role: "system", content: summarize(this.session.messages.slice(0, this.session.compactedFrom)) });
    msgs.push(...ctx);
    return msgs;
  }

  async *runTurn(userText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    this.session.append({ role: "user", content: userText });
    if (!this.session.title)
      this.session.title = userText.trim().split("\n")[0]?.slice(0, 80) ?? "session";
    let steps = 0;
    while (steps < this.maxSteps) {
      steps += 1;
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      for await (const ev of this.streamWithRetry(signal)) {
        if (ev.kind === "error") { yield ev; return; }
        if (ev.kind === "text") { assistantText += ev.text; yield ev; }
        else if (ev.kind === "thinking") yield ev;
        else if (ev.kind === "usage") yield ev;
        else if (ev.kind === "retry") yield ev;
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

  /**
   * One model step with retry: transient failures (429/5xx/network) that
   * happen before any content streams are retried with exponential backoff +
   * jitter, honoring a retry-after hint. Once tokens have flowed we surface
   * the error instead of retrying — re-asking would duplicate partial output.
   */
  private async *streamWithRetry(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    for (let attempt = 1; ; attempt++) {
      let sawContent = false;
      let timedOut = false;
      // per-attempt deadline: a hung provider becomes a retryable 408, not a freeze.
      // (manual timer, cleared in finally — AbortSignal.timeout would keep the
      // process alive on its pending timer long after the stream ended)
      const ctrl = new AbortController();
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.requestTimeoutMs);
      const onUserAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onUserAbort);
      try {
        for await (const ev of this.streamOnce(ctrl.signal)) {
          if (ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_calls") sawContent = true;
          yield ev;
        }
        return;
      } catch (e: any) {
        if (timedOut && !signal?.aborted)
          e = new Error(`request timed out after ${Math.round(this.requestTimeoutMs / 1000)}s`);
        if (timedOut && !signal?.aborted) (e as any).status = 408;
        const retryable = isRetryableLLMError(e) && !sawContent && attempt < this.maxAttempts && !signal?.aborted;
        if (!retryable) {
          yield { kind: "error", text: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
          return;
        }
        const backoff = Math.min(RETRY_MAX_MS, this.retryBaseMs * 2 ** (attempt - 1));
        const header = (e as any)?.retryAfterSec;
        const waitMs = Math.min(
          RETRY_MAX_MS,
          Number.isFinite(header) && header! > 0 ? Math.round(header! * 1000) : Math.round(backoff * (0.75 + Math.random() * 0.5)),
        );
        yield { kind: "retry", attempt, waitMs, reason: String(e?.message ?? e).slice(0, 160) };
        try {
          await sleep(waitMs, signal);
        } catch {
          yield { kind: "error", text: "interrupted during retry" };
          return;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onUserAbort);
      }
    }
  }

  private async *streamOnce(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    for await (const ev of this.client.streamChat(
      this.messages(), this.tools.specs(),
      { model: modelId(this.session.model), maxTokens: this.maxTokens, temperature: this.temperature, signal },
    )) {
      if (ev.textDelta) yield { kind: "text", text: ev.textDelta };
      else if (ev.thinkingDelta) yield { kind: "thinking", text: ev.thinkingDelta };
      else if (ev.usage) {
        this.session.usage.in += ev.usage.prompt;
        this.session.usage.out += ev.usage.completion;
        yield { kind: "usage", text: `${ev.usage.prompt}+${ev.usage.completion} tok`, usage: ev.usage };
      }
      else if (ev.toolCalls) yield { kind: "tool_calls", toolCalls: ev.toolCalls };
      else if (ev.error) yield { kind: "error", text: ev.error };
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

export function modelId(sessionModel: string): string {
  const i = sessionModel.indexOf("/");
  return i > 0 ? sessionModel.slice(i + 1) : sessionModel;
}

/** Sleep that rejects early if the abort signal fires (esc during backoff). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
