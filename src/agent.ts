/**
 * The agent loop: prompt -> stream -> tool calls -> results -> repeat.
 * Model-agnostic: one ChatClient interface (from llm.make_client) behind
 * every provider. Events are yielded so the UI can render incrementally.
 */
import { buildSystemPrompt } from "./system-prompt.ts";
import { isRetryableLLMError, type ChatClient, type Message, type StreamEvent, type ToolCall, type ToolSpec } from "./llm.ts";
import { Session, summarize } from "./session.ts";
import { ToolKit, type PermissionFn, type Todo } from "./tools.ts";

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
  | { kind: "todo"; todos: Todo[] }
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
    if (this.session.compactedFrom > 0) {
      const digest = this.session.digest ||
        summarize(this.session.messages.slice(0, this.session.compactedFrom));
      msgs.push({ role: "system", content: digest });
    }
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
        if (call.name === "todo" && result.ok)
          yield { kind: "todo", todos: this.tools.plan() };
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

  /**
   * Model-written compaction (Claude Code /compact semantics): ask the model
   * to summarize the fold zone, store it as the digest, move the cut. On any
   * failure fall back to the deterministic digest — compaction never blocks.
   * Returns { folded, summary, model }.
   */
  async compactNow(signal?: AbortSignal): Promise<{ folded: number; summary: string; model: boolean }> {
    const msgs = this.session.messages;
    const keep = Math.max(8, Math.floor(msgs.length / 3));
    let cut = Math.max(0, msgs.length - keep);
    while (cut < msgs.length && msgs[cut]?.role === "tool") cut++;
    if (cut <= this.session.compactedFrom)
      return { folded: 0, summary: "", model: false };
    const fold = msgs.slice(this.session.compactedFrom, cut);
    const transcript = fold
      .map((m) => `${m.role}${m.toolCalls?.length ? `(${m.toolCalls.map((tc) => tc.name).join(",")})` : ""}: ${m.content.slice(0, 700)}`)
      .join("\n")
      .slice(0, 120_000);
    let summary = "";
    let usedModel = false;
    try {
      let acc = "";
      for await (const ev of this.client.streamChat(
        [
          { role: "system", content: "You compress coding-agent transcripts. Write a dense continuation summary of the transcript below: user goals and constraints, decisions made, files created/edited (paths), current state, and open threads. Under 500 words. Plain text, no preamble." },
          { role: "user", content: transcript },
        ],
        [],
        { model: modelId(this.session.model), maxTokens: 1024, temperature: 0.2, signal },
      )) {
        if (ev.textDelta) acc += ev.textDelta;
        if (ev.error) throw new Error(ev.error);
      }
      if (acc.trim()) { summary = acc.trim(); usedModel = true; }
    } catch { /* fall through to digest */ }
    if (!summary) summary = summarize(fold);
    this.session.digest = this.session.digest
      ? this.session.digest + "\n\n" + summary
      : summary;
    this.session.compactedFrom = cut;
    this.session.save();
    return { folded: cut, summary, model: usedModel };
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
