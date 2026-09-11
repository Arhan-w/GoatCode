/**
 * The agent loop: prompt -> stream -> tool calls -> results -> repeat.
 * Model-agnostic: one ChatClient interface (from llm.make_client) behind
 * every provider. Events are yielded so the UI can render incrementally.
 */
import { buildSystemPrompt } from "./system-prompt.ts";
import { contentChars, isRetryableLLMError, textOf, type ChatClient, type ContentPart, type Message, type StreamEvent, type ToolCall, type ToolSpec } from "./llm.ts";
import { Session, summarize } from "./session.ts";
import { ToolKit, type PermissionFn, type Todo, type ToolResult } from "./tools.ts";
import { fireHooks, MAX_STOP_HOOK_CONTINUES } from "./hooks.ts";
import { SUBAGENT_MAX_STEPS } from "./constants.ts";

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
  | { kind: "usage"; text: string; usage?: { prompt: number; completion: number; cacheRead?: number; cacheWrite?: number } }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }
  | { kind: "retry"; attempt: number; waitMs: number; reason: string }
  | { kind: "fallback"; from: string; to: string; reason: string }
  | { kind: "todo"; todos: Todo[] }
  | { kind: "error"; text: string }
  | { kind: "done" };

/** Read-only tools the agent may run concurrently within one step
 *  (Claude Code parallelizes these too). Excludes anything that can raise a
 *  permission prompt — two simultaneous prompts would deadlock one of them. */
export const CONCURRENT_SAFE = new Set(["read", "glob", "grep", "tasks"]);

export interface AgentDeps {
  client: ChatClient;
  /** Anthropic prompt caching (system+tools ephemeral cache). */
  cache?: boolean;
  /** Cheaper client for background work (compaction, explore subagents). */
  smallClient?: ChatClient;
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
  /** Tools hidden from the model AND refused at dispatch (subagent guardrails). */
  disallowedTools?: Set<string>;
  /** Providers tried, in order, when the primary hard-fails before streaming
   *  any content (quota exhausted, bad/expired auth, provider down). */
  fallbacks?: Array<{ client: ChatClient; model: string }>;
}

export class Agent {
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
  /** Real prompt-token count of the most recent API call (true context size). */
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
    this.retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    this.maxAttempts = deps.maxAttempts ?? LLM_MAX_ATTEMPTS;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.disallowedTools = deps.disallowedTools ?? new Set();
    this.fallbacks = deps.fallbacks ? [...deps.fallbacks] : [];
    this.cache = deps.cache ?? false;
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

  async *runTurn(userText: string | ContentPart[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    this.session.append({ role: "user", content: userText });
    if (!this.session.title) {
      const first = typeof userText === "string" ? userText : textOf(userText);
      this.session.title = first.trim().split("\n")[0]?.slice(0, 80) ?? "session";
    }
    let steps = 0;
    let stopContinues = 0;
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
        else if (ev.kind === "fallback") yield ev;
        else if (ev.kind === "tool_calls") toolCalls.push(...ev.toolCalls);
      }
      if (!toolCalls.length) {
        this.session.append({ role: "assistant", content: assistantText });
        // Stop hooks: a blocking hook feeds its reason back as a new user turn
        // (capped) — Claude's "keep going until the guard is satisfied" model.
        if (this.tools.hooks?.Stop?.length && stopContinues < MAX_STOP_HOOK_CONTINUES) {
          const hr = await fireHooks(this.tools.hooks, "Stop", {
            session_id: this.tools.sessionId, transcript_path: "", cwd: this.tools.root,
            hook_event_name: "Stop", hookEventName: "Stop",
            stop_hook_active: stopContinues > 0,
          } as any, this.tools.sessionId);
          if (hr.blocked && hr.reason) {
            stopContinues += 1;
            yield { kind: "text", text: `\n⟲ Stop hook: continuing (${stopContinues}/${MAX_STOP_HOOK_CONTINUES})\n` };
            this.session.append({ role: "user", content: `[stop-hook feedback] ${hr.reason}` });
            continue;
          }
        }
        this.session.save();
        yield { kind: "done" };
        return;
      }
      const assistantMsg: Message & { toolCalls: ToolCall[] } = {
        role: "assistant", content: assistantText, toolCalls,
      };
      this.session.append(assistantMsg as Message);
      // Read-only tools (read/grep/glob/webfetch/...) fan out concurrently —
      // a 5-file exploration costs one round of latency, not five. Everything
      // else (writes, bash, permission-prompting calls) stays sequential.
      const results = new Map<ToolCall, ToolResult>();
      let i = 0;
      while (i < toolCalls.length) {
        // Parallel subagents: consecutive `task` calls fan out (cap 3) — each
        // gets a fresh context, so they're independent by construction.
        // Permission prompts from inside them are serialized by the TUI queue.
        if (toolCalls[i].name === "task" && !this.disallowedTools.has("task")) {
          const batch: ToolCall[] = [];
          while (i < toolCalls.length && toolCalls[i].name === "task" && batch.length < 3)
            batch.push(toolCalls[i++]);
          for (const c of batch)
            yield { kind: "tool_start", tool: "task", args: c.arguments };
          const settled = await Promise.all(
            batch.map((c) => this.spawnSubagent(c.arguments, signal)));
          batch.forEach((c, k) => results.set(c, settled[k]));
          continue;
        }
        if (CONCURRENT_SAFE.has(toolCalls[i].name) && !this.disallowedTools.has(toolCalls[i].name)) {
          const batch: ToolCall[] = [];
          while (i < toolCalls.length && CONCURRENT_SAFE.has(toolCalls[i].name)) batch.push(toolCalls[i++]);
          for (const c of batch) yield { kind: "tool_start", tool: c.name, args: c.arguments };
          const settled = await Promise.all(batch.map((c) => this.tools.dispatch(c.name, c.arguments, signal)));
          batch.forEach((c, k) => results.set(c, settled[k]));
        } else {
          const call = toolCalls[i++];
          yield { kind: "tool_start", tool: call.name, args: call.arguments };
          let result;
          if (call.name === "task") {
            if (this.disallowedTools.has("task"))
              result = { ok: false, output: "subagents cannot spawn subagents" };
            else result = await this.spawnSubagent(call.arguments, signal);
          } else {
            result = await this.tools.dispatch(call.name, call.arguments, signal);
          }
          results.set(call, result);
        }
      }
      for (const call of toolCalls) {
        const result = results.get(call)!;
        this.session.append({
          role: "tool",
          content: result.content ?? result.output.slice(0, 60_000),
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
        const specs = this.tools.specs().filter((s) => !this.disallowedTools.has(s.name));
      for await (const ev of this.streamOnce(ctrl.signal, specs)) {
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
          // Primary is out of retries (or hit a hard error like quota/auth).
          // Before killing the turn, walk the fallback chain — each entry gets
          // one shot; the first that streams content wins and sticks for the
          // rest of the session (this.client / session.model are swapped).
          if (!sawContent && !signal?.aborted && this.fallbacks.length) {
            const from = this.session.model;
            const reason = String(e?.message ?? e).slice(0, 160);
            let switched = false;
            while (this.fallbacks.length) {
              const fb = this.fallbacks.shift()!;
              try {
                for await (const ev of this.streamOnce(signal, undefined, fb.client, fb.model)) {
                  if (ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_calls") {
                    if (!switched) {
                      switched = true;
                      this.client = fb.client;
                      this.session.model = fb.model;
                      yield { kind: "fallback", from, to: fb.model, reason };
                    }
                  }
                  yield ev;
                }
                if (switched) return; // stream completed on the fallback
              } catch (fe: any) {
                if (switched) {
                  // already streamed partial output here — re-falling-back would
                  // duplicate it; surface the error instead (Claude semantics)
                  yield { kind: "error", text: `${fe?.name ?? "Error"}: ${fe?.message ?? fe}` };
                  return;
                }
                /* this fallback failed pre-content — try the next */
              }
            }
            if (switched) return;
            yield { kind: "error", text: `all providers failed — last error: ${reason}` };
            return;
          }
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

  private async *streamOnce(signal?: AbortSignal, specs?: ToolSpec[],
    client?: ChatClient, model?: string): AsyncGenerator<AgentEvent> {
    for await (const ev of (client ?? this.client).streamChat(
      this.messages(), specs ?? this.tools.specs(),
      { model: modelId(model ?? this.session.model), maxTokens: this.maxTokens, temperature: this.temperature, signal, cache: this.cache },
    )) {
      if (ev.textDelta) yield { kind: "text", text: ev.textDelta };
      else if (ev.thinkingDelta) yield { kind: "thinking", text: ev.thinkingDelta };
      else if (ev.usage) {
        this.session.usage.in += ev.usage.prompt;
        this.session.usage.out += ev.usage.completion;
        // true context size = everything the model saw this call (uncached +
        // cached prompt tokens)
        this.lastPromptTokens = ev.usage.prompt + (ev.usage.cacheRead ?? 0) + (ev.usage.cacheWrite ?? 0);
        if (ev.usage.cacheRead) this.session.usage.cacheRead = (this.session.usage.cacheRead ?? 0) + ev.usage.cacheRead;
        if (ev.usage.cacheWrite) this.session.usage.cacheWrite = (this.session.usage.cacheWrite ?? 0) + ev.usage.cacheWrite;
        yield { kind: "usage", text: `${ev.usage.prompt}+${ev.usage.completion} tok`, usage: ev.usage };
      }
      else if (ev.toolCalls) yield { kind: "tool_calls", toolCalls: ev.toolCalls };
      else if (ev.error) yield { kind: "error", text: ev.error };
    }
  }

  /**
   * Sub-agent: fresh context (no history bleed), shared ToolKit so undo,
   * permission rules, hooks and MCP all apply. Explore mode = read-only
   * toolset. Returns the sub-agent's final text as the tool result.
   */
  private async spawnSubagent(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return { ok: false, output: "task requires a prompt" };
    const description = String(args.description ?? "subagent").slice(0, 60);
    const explore = String(args.subagent_type ?? "") === "explore";
    const disallowed = new Set(["task", "write", "edit", "undo", ...(explore ? ["bash", "computer"] : ["computer"])]);
    const sub = Session.new(this.session.cwd, this.session.model);
    sub.title = `subagent: ${description}`;
    const child = new Agent({
      // explore agents are pure reading: route them to the cheap model if configured
      client: explore && this.smallClient ? this.smallClient : this.client,
      session: sub, tools: this.tools,
      maxTokens: this.maxTokens, temperature: this.temperature,
      maxSteps: SUBAGENT_MAX_STEPS, extraSystem: this.extraSystem,
      retryBaseMs: this.retryBaseMs, maxAttempts: this.maxAttempts,
      requestTimeoutMs: this.requestTimeoutMs, disallowedTools: disallowed,
    });
    let text = "";
    let stepsUsed = 0;
    let error = "";
    for await (const ev of child.runTurn(prompt, signal)) {
      if (ev.kind === "text") text += ev.text;
      else if (ev.kind === "tool_start") stepsUsed++;
      else if (ev.kind === "error") error = ev.text;
    }
    const final = text.trim();
    if (!final)
      return { ok: false, output: `subagent "${description}" produced no answer${error ? `: ${error}` : ""}` };
    return { ok: true, output: `[subagent ${description} · ${stepsUsed} tool uses]\n${final.slice(0, 30_000)}` };
  }

  private maybeCompact(): void {
    const total = this.session.messages.reduce((s, m) => s + contentChars(m.content), 0);
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
      .map((m) => `${m.role}${m.toolCalls?.length ? `(${m.toolCalls.map((tc) => tc.name).join(",")})` : ""}: ${textOf(m.content).slice(0, 700)}`)
      .join("\n")
      .slice(0, 120_000);
    let summary = "";
    let usedModel = false;
    try {
      let acc = "";
      for await (const ev of (this.smallClient ?? this.client).streamChat(
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
