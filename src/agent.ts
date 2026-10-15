/**
 * The agent loop: prompt -> stream -> tool calls -> results -> repeat.
 * Model-agnostic: one ChatClient interface (from llm.make_client) behind
 * every provider. Events are yielded so the UI can render incrementally.
 */
import { buildSystemPrompt } from "./system-prompt.ts";
import { contentChars, isRetryableLLMError, textOf, type ChatClient, type ContentPart, type Message, type StreamEvent, type ToolCall, type ToolSpec } from "./llm.ts";
import { Session, summarize } from "./session.ts";
import { ToolKit, getToolSpec, type PermissionFn, type Todo, type ToolEvent, type ToolResult } from "./tools.ts";
import type { AgentDef } from "./agents/loader.ts";
import { fireHooks, MAX_STOP_HOOK_CONTINUES } from "./hooks.ts";
import { SUBAGENT_MAX_STEPS, ULTRACODE_FANOUT } from "./constants.ts";
import { costUsd } from "./pricing.ts";
import { ConfigError, ProviderError, AuthError, RateLimitError, GoatError, GenericError } from "./errors.ts";

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
  | { kind: "tool_start"; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: "tool_output"; callId: string; tool: string; text: string }
  | { kind: "tool_end"; tool: string; result: string; ok: boolean; callId?: string; durationMs?: number }
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
  /** Live tool telemetry sink (UI wiring). Forwarded to tools.toolEvent. */
  onToolEvent?: (ev: ToolEvent) => void;
  /** Custom subagent definitions (subagent_type -> persona + tool allowlist). */
  customAgents?: AgentDef[];
  /** Resolve an arbitrary model string ("provider/model") to a live client.
   *  Powers the custom-agent `model:` override; when absent (tests) the
   *  override falls back to the parent's client. */
  resolveClientFor?: (model: string) => Promise<ChatClient>;
  /** Hard spend ceiling in USD for this session. When the accumulated cost
   *  (priced models only) reaches it, the turn stops with a clear error
   *  instead of burning silently. Unset or 0 = no cap. */
  budgetUsd?: number;
  /** Auto-title the session with the small model after the first turn. */
  autoTitle?: boolean;
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
  /** Custom subagent types this agent can spawn (name -> def). */
  customAgents: AgentDef[];
  /** Model-string -> live client resolver for custom-agent model overrides. */
  resolveClientFor?: (model: string) => Promise<ChatClient>;
  /** Hard spend ceiling (USD); turn stops when the priced cost reaches it. */
  budgetUsd: number;
  /** Generate a session title with the model after the first turn. */
  autoTitle: boolean;
  /** Real prompt-token count of the most recent API call (true context size). */
  lastPromptTokens = 0;
  /** Circuit breaker: tracks consecutive failures per provider to avoid rapid re-failure. */
  private _circuitBreaker: Map<string, { failures: number; lastFailureTime: number }> = new Map();
  /** Max consecutive failures before circuit opens (provider is skipped). */
  static readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  /** Time window (ms) for counting consecutive failures. */
  static readonly CIRCUIT_BREAKER_WINDOW_MS = 60_000;

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
    this.customAgents = deps.customAgents ?? [];
    this.resolveClientFor = deps.resolveClientFor;
    this.budgetUsd = deps.budgetUsd ?? 0;
    this.autoTitle = deps.autoTitle ?? false;
    if (deps.onToolEvent) this.tools.toolEvent = deps.onToolEvent;
  }

  /** Record a failure for a provider in the circuit breaker. */
  recordFailure(provider: string): void {
    const now = Date.now();
    const state = this._circuitBreaker.get(provider) ?? { failures: 0, lastFailureTime: 0 };
    // Reset counter if outside the time window
    if (now - state.lastFailureTime > Agent.CIRCUIT_BREAKER_WINDOW_MS) {
      state.failures = 1;
    } else {
      state.failures += 1;
    }
    state.lastFailureTime = now;
    this._circuitBreaker.set(provider, state);
  }

  /** Check if a provider's circuit is open (should be skipped). */
  isCircuitOpen(provider: string): boolean {
    const state = this._circuitBreaker.get(provider);
    if (!state) return false;
    const now = Date.now();
    if (now - state.lastFailureTime > Agent.CIRCUIT_BREAKER_WINDOW_MS) return false;
    return state.failures >= Agent.CIRCUIT_BREAKER_THRESHOLD;
  }

  /** Reset circuit breaker for a provider (called on success). */
  resetCircuit(provider: string): void {
    this._circuitBreaker.delete(provider);
  }

  /** Get circuit breaker stats for display. */
  getCircuitBreakerStats(): Array<{ provider: string; failures: number; open: boolean }> {
    const now = Date.now();
    const result: Array<{ provider: string; failures: number; open: boolean }> = [];
    for (const [provider, state] of this._circuitBreaker) {
      const isOpen = now - state.lastFailureTime <= Agent.CIRCUIT_BREAKER_WINDOW_MS &&
        state.failures >= Agent.CIRCUIT_BREAKER_THRESHOLD;
      result.push({ provider, failures: state.failures, open: isOpen });
    }
    return result;
  }

  private messages(): Message[] {
    const ctx = this.session.context();
    const agentDescs = this.customAgents.map((a) => `${a.name}: ${a.description}${a.tools?.length ? ` (tools: ${a.tools.join(", ")})` : ""}`);
    let sys = buildSystemPrompt(this.session.cwd, agentDescs);
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
        // Spend-budget guard (checked on the natural turn end, never mid-stream):
        // priced models only — unpriced ones can't be measured and never trip.
        if (this.budgetUsd > 0) {
          const spent = costUsd(this.session.model, this.session.usage);
          if (spent != null && spent >= this.budgetUsd) {
            this.session.save();
            yield { kind: "error", text: `spend budget reached: $${spent.toFixed(2)} of $${this.budgetUsd.toFixed(2)} (budget_usd in config) — raise it or switch to a cheaper model to continue` };
            return;
          }
        }
        // Auto-title: after the first exchange, ask the small (or main) model
        // for a short title. Best-effort — failures never affect the turn.
        if (this.autoTitle && !this.session.titleTouched) {
          this.session.titleTouched = true;
          void this.autoTitleSession();
        }
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
      // per-tool wall clock for the UI (⎿ completed · 2.3s)
      const durations = new Map<ToolCall, number>();
      // Mark turn start for crash recovery (before tool execution).
      this.session.markTurnStart(this.session.messages.length, toolCalls.map((tc) => ({
        tool: tc.name,
        args: tc.arguments,
        callId: tc.id,
      })));
      // Dependency-aware parallel scheduler: tools whose writeSets don't overlap
      // run concurrently. Read-only tools (read/grep/glob/...) naturally batch
      // together; mutating tools (write/edit/bash/todo/...) run sequentially
      // relative to each other but may overlap with pure reads. GOAT MODE
      // (bypass) widens the batch to ULTRACODE_FANOUT so `task` calls really
      // fan out to 8 as promised in the UI.
      const MAX_PARALLEL = this.tools.goat ? ULTRACODE_FANOUT : 4;
      const results = new Map<ToolCall, ToolResult>();
      const pending: ToolCall[] = [...toolCalls];
      const completed = new Set<string>();

      while (pending.length > 0) {
        // Build next batch: pick up to MAX_PARALLEL tools that don't conflict
        // with already-running writes (this round) or any completed writes.
        const batch: ToolCall[] = [];
        const remaining = pending.filter((tc) => {
          if (batch.length >= MAX_PARALLEL) return true; // keep in pending
          const deps = getToolSpec(tc.name, tc.arguments);
          // Check conflict against already-running tools in this batch
          const conflicts = batch.some((other) => {
            const otherDeps = getToolSpec(other.name, other.arguments);
            return (
              deps.writeSet.some((w) => otherDeps.writeSet.includes(w)) ||
              deps.readSet.some((r) => otherDeps.writeSet.includes(r)) ||
              otherDeps.readSet.some((r) => deps.writeSet.includes(r))
            );
          });
          // Check conflict against completed writes
          const conflictsCompleted = deps.writeSet.some((w) => completed.has(w)) ||
            deps.readSet.some((r) => completed.has(r));
          if (conflicts || conflictsCompleted) return true;
          batch.push(tc);
          return false;
        });
        pending.length = 0;
        remaining.forEach((tc) => pending.push(tc));

        if (batch.length === 0) {
          // Deadlock: no tool can proceed (all conflict with completed writes).
          // Fall back to sequential execution of the first pending tool.
          const call = pending.shift()!;
          batch.push(call);
        }

        // Execute batch. Wrap toolEvent once around the batch: capture the
        // per-call id dispatch assigns (start) and queue streamed output
        // deltas so they can be yielded with the model-side ToolCall id.
        // Always installed — deltas feed the UI even when no toolEvent sink
        // is attached (the TUI consumes runTurn events directly).
        const outerToolEvent = this.tools.toolEvent;
        const callIds = new Map<ToolCall, string>();
        const streamedDeltas: Array<{ callId: string; tool: string; text: string }> = [];
        this.tools.toolEvent = (ev) => {
          try { outerToolEvent?.(ev); } catch { /* sink errors are already isolated */ }
          if (ev.kind === "start") {
            const match = batch.find((c) => c.name === ev.tool && !callIds.has(c));
            if (match) callIds.set(match, ev.callId);
          } else if (ev.kind === "output") {
            streamedDeltas.push({ callId: ev.callId, tool: ev.tool, text: ev.text ?? "" });
          }
        };
        for (const call of batch) {
          yield { kind: "tool_start", tool: call.name, args: call.arguments, callId: call.id };
        }
        const batchT0 = Date.now();
        if (batch.length === 1) {
          const call = batch[0];
          const result = await (call.name === "task" && !this.disallowedTools.has("task")
            ? this.spawnSubagent(call.arguments, signal)
            : this.tools.dispatch(call.name, call.arguments, signal));
          results.set(call, result);
        } else {
          // Parallel execution for the batch
          const settled = await Promise.all(
            batch.map(async (call) => {
              if (call.name === "task" && !this.disallowedTools.has("task")) {
                return this.spawnSubagent(call.arguments, signal);
              }
              return this.tools.dispatch(call.name, call.arguments, signal);
            }),
          );
          batch.forEach((call, k) => results.set(call, settled[k]));
        }
        const batchMs = Date.now() - batchT0;
        for (const call of batch) durations.set(call, batchMs);
        this.tools.toolEvent = outerToolEvent;
        // Forward streamed output mapped to the model-side call id so the UI
        // can attach deltas to the row it created for this ToolCall.
        for (const d of streamedDeltas) {
          const call = batch.find((c) => callIds.get(c) === d.callId);
          yield { kind: "tool_output", callId: call?.id ?? d.callId, tool: d.tool, text: d.text };
        }
        // Record completed writes for conflict detection
        for (const call of batch) {
          const deps = getToolSpec(call.name, call.arguments);
          deps.writeSet.forEach((w) => completed.add(w));
        }
      }
      for (const call of toolCalls) {
        const result = results.get(call)!;
        this.session.append({
          role: "tool",
          content: result.content ?? result.output.slice(0, 60_000),
          toolCallId: call.id, name: call.name,
        });
        yield { kind: "tool_end", tool: call.name, result: result.output.slice(0, 2000), ok: result.ok, callId: call.id, durationMs: durations.get(call) };
        if (call.name === "todo" && result.ok)
          yield { kind: "todo", todos: this.tools.plan() };
      }
      // Clear crash recovery marker — turn completed successfully.
      this.session.clearTurnMarker();
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
        const err = e instanceof GoatError ? e : new GenericError(`${e?.name ?? "Error"}: ${e?.message ?? e}`, {
          suggestion: 'Check provider status or try a different provider'
        });
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
              // Extract provider ID from model string (format: "provider/model")
              const fbProvider = fb.model.split("/")[0];
              // Skip if circuit is open for this provider
              if (this.isCircuitOpen(fbProvider)) {
                continue;
              }
              try {
                for await (const ev of this.streamOnce(signal, undefined, fb.client, fb.model)) {
                  if (ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_calls") {
                    if (!switched) {
                      switched = true;
                      this.client = fb.client;
                      this.session.model = fb.model;
                      this.resetCircuit(fbProvider); // Success — reset circuit
                      yield { kind: "fallback", from, to: fb.model, reason };
                    }
                  }
                  yield ev;
                }
                if (switched) return; // stream completed on the fallback
              } catch (fe: any) {
                this.recordFailure(fbProvider); // Record failure in circuit breaker
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
            yield { kind: "error", text: `all providers failed — ${err.code}: ${err.message}` };
            return;
          }
          yield { kind: "error", text: `${err.code}: ${err.message}\n  💡 ${err.suggestion ?? ''}` };
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
   * Sub-agent: fresh context (no history bleed), cloned ToolKit so undo,
   * permission rules, hooks and MCP all apply independently. Explore mode
   * = read-only toolset. Returns the sub-agent's final text as the tool
   * result.
   *
   * The cloned toolkit gets a fresh session with a "sub-" prefixed id so
   * session fork metadata can track parent -> child relationships.
   */
  private async spawnSubagent(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return { ok: false, output: "task requires a prompt" };
    const description = String(args.description ?? "subagent").slice(0, 60);
    const agentType = String(args.subagent_type ?? "");
    const explore = agentType === "explore";
    // custom agent types (loaded from ./.goat/agents, ./agents, ~/.goatcode/agents)
    const custom = this.customAgents.find((a) => a.name === agentType);
    if (agentType && agentType !== "general" && agentType !== "explore" && !custom)
      return { ok: false, output: `unknown subagent_type "${agentType}" — available: general, explore${this.customAgents.length ? ", " + this.customAgents.map((a) => a.name).join(", ") : ""}` };
    // explore = read-only; general and custom agents run with their documented
    // toolsets. task/undo/computer stay off-limits for every subagent.
    const disallowed = new Set<string>(["task", "undo", "computer"]);
    if (explore) disallowed.add("write"), disallowed.add("edit"), disallowed.add("multiedit"), disallowed.add("bash");
    // a custom agent's tool allowlist hides everything not listed (task/undo
    // are blocked again below regardless of what the allowlist contains)
    if (custom?.tools?.length) {
      const allowed = new Set(custom.tools);
      for (const s of this.tools.specs()) if (!allowed.has(s.name)) disallowed.add(s.name);
    }
    disallowed.add("task"); // subagents never spawn subagents
    disallowed.add("undo"); // and never touch the undo stack

    // --- isolated toolkit clone ---
    const subToolKit = this.tools.clone();
    subToolKit.parentSessionId = this.session.id;
    const forkIdx = (this.session.subagentForks?.length ?? 0);
    subToolKit.forkIndex = forkIdx;

    // resolve the child's model: a custom agent's `model:` override wins,
    // explore agents route to the cheap model when configured, else the parent's
    let childClient = explore && this.smallClient ? this.smallClient : this.client;
    if (custom?.model && this.resolveClientFor) {
      try { childClient = await this.resolveClientFor(custom.model); }
      catch { /* unresolvable override — fall back to the parent client */ }
    }
    const forkSession = new Session({
      id: `sub-${crypto.randomUUID()}`,
      cwd: this.session.cwd,
      model: custom?.model ?? this.session.model,
    });
    forkSession.title = `subagent: ${description}`;
    // record the fork in the parent session
    this.session.addSubagentFork({
      childId: forkSession.id,
      description,
      explore,
      startedAt: Date.now(),
    });
    const child = new Agent({
      client: childClient,
      session: forkSession, tools: subToolKit,
      maxTokens: this.maxTokens, temperature: this.temperature,
      maxSteps: SUBAGENT_MAX_STEPS,
      extraSystem: [this.extraSystem, custom?.body ? `## Agent: ${custom.name}\n\n${custom.body}` : ""]
        .filter(Boolean).join("\n\n"),
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
    // record completion in the parent session
    this.session.completeSubagentFork(forkSession.id, { stepsUsed, error });

    const final = text.trim();
    if (!final)
      return { ok: false, output: `subagent "${description}" produced no answer${error ? `: ${error}` : ""}` };
    return { ok: true, output: `[subagent ${description} · ${stepsUsed} tool uses]\n${final.slice(0, 30_000)}` };
  }

  /**
   * Auto-title the session from the first exchange using the small model
   * (fallback: main client). Writes a 3-6 word title, never throws.
   */
  private async autoTitleSession(): Promise<void> {
    const firstUser = [...this.session.messages].find((m) => m.role === "user");
    if (!firstUser) return;
    const brief = textOf(firstUser.content).replace(/\s+/g, " ").slice(0, 300);
    try {
      let acc = "";
      for await (const ev of (this.smallClient ?? this.client).streamChat(
        [
          { role: "system", content: "Write a 3-6 word title for a coding session started by this request. Plain text only: no quotes, no punctuation at the end, no preamble." },
          { role: "user", content: brief },
        ],
        [],
        { model: modelId(this.session.model), maxTokens: 24, temperature: 0.3 },
      )) {
        if (ev.textDelta) acc += ev.textDelta;
        if (ev.error) return;
      }
      const title = acc.trim().replace(/^["'#\s]+|["'.\s]+$/g, "").slice(0, 60);
      if (title) {
        this.session.title = title;
        this.session.save();
      }
    } catch { /* titling is cosmetic — never surface */ }
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
