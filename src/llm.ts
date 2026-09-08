/**
 * Streaming chat clients for the four wire formats:
 *   openai            POST /chat/completions   (SSE)
 *   claude            POST /messages           (SSE, x-api-key or bearer)
 *   openai-responses  POST /responses          (SSE)
 *   gemini            :streamGenerateContent   (SSE; cloudcode-pa OAuth shape)
 *
 * All yield the same StreamEvent shape so the agent loop is model-agnostic.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface StreamEvent {
  textDelta?: string;
  thinkingDelta?: string;
  toolCalls?: ToolCall[];
  usage?: { prompt: number; completion: number };
  error?: string;
}

export class LLMError extends Error {
  /** HTTP status when the failure came from a response, else undefined. */
  status?: number;
  /** Seconds parsed from a retry-after header, when the server sent one. */
  retryAfterSec?: number;
  constructor(message: string, opts?: { status?: number; retryAfterSec?: number }) {
    super(message);
    this.name = "LLMError";
    this.status = opts?.status;
    this.retryAfterSec = opts?.retryAfterSec;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NETWORK_HINTS = ["fetch failed", "enotfound", "eai_again", "etimedout", "econnreset", "econnrefused", "socket hang up", "network", "timed out", "terminated"];

/** Transient enough to retry: 429/5xx, or a network-level failure. User aborts are never retryable. */
export function isRetryableLLMError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: string; message?: string; status?: number };
  if (err.name === "AbortError") return false;
  if (typeof err.status === "number") return RETRYABLE_STATUS.has(err.status);
  const msg = String(err.message ?? "").toLowerCase();
  return NETWORK_HINTS.some((h) => msg.includes(h));
}

function retryAfterSeconds(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

export interface StreamOpts {
  model: string;
  maxTokens: number;
  temperature?: number | null;
  signal?: AbortSignal;
}

export interface ChatClient {
  streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent>;
}

// ---------- SSE plumbing ----------

async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith("data:")) yield buf.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

async function postJson(
  url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e: any) {
    throw new LLMError(`${e?.name ?? "network"}: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 600)}`, {
      status: res.status, retryAfterSec: retryAfterSeconds(res),
    });
  }
  return res;
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function finishToolCalls(partial: Map<number, { id: string; name: string; args: string }>): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [, p] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    if (!p.name) continue;
    let args: Record<string, unknown> = {};
    try { args = p.args ? JSON.parse(p.args) : {}; } catch { args = { _raw: p.args }; }
    calls.push({ id: p.id || `call_${calls.length}`, name: p.name, arguments: args });
  }
  return calls;
}

// ---------- OpenAI chat completions ----------

export class OpenAIChatClient implements ChatClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private extraHeaders?: Record<string, string>,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey ?? ""}`, ...(this.extraHeaders ?? {}) };
  }

  async *streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent> {
    const payload: any = {
      model: opts.model,
      max_tokens: opts.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: messages.flatMap((m): any[] => {
        if (m.role === "system") return [{ role: "system", content: m.content }];
        if (m.role === "tool")
          return [{ role: "tool", tool_call_id: m.toolCallId, content: m.content }];
        if (m.role === "assistant" && m.toolCalls?.length)
          return [{
            role: "assistant", content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id, type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }];
        return [{ role: m.role, content: m.content }];
      }),
    };
    if (opts.temperature != null) payload.temperature = opts.temperature;
    if (tools.length)
      payload.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));

    const res = await postJson(`${this.baseUrl}/chat/completions`, this.headers(), payload, opts.signal);
    const partial = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of sseLines(res)) {
      if (data === "[DONE]") break;
      const obj = safeParse(data);
      if (!obj) continue;
      const choice = obj.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) yield { textDelta: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = partial.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partial.set(idx, cur);
      }
      if (obj.usage)
        yield { usage: { prompt: obj.usage.prompt_tokens ?? 0, completion: obj.usage.completion_tokens ?? 0 } };
      if (choice?.finish_reason === "tool_calls" || choice?.finish_reason === "stop") {
        if (partial.size) yield { toolCalls: finishToolCalls(partial) };
      }
    }
  }
}

// ---------- Anthropic messages ----------

export class AnthropicClient implements ChatClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private authToken?: string,
    private extraHeaders?: Record<string, string>,
  ) {}

  private headers(): Record<string, string> {
    const base: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (this.authToken) {
      base.authorization = `Bearer ${this.authToken}`;
      base["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      base["x-api-key"] = this.apiKey ?? "";
    }
    return { ...base, ...(this.extraHeaders ?? {}) };
  }

  /** System messages concatenate; consecutive tool results merge into ONE
   * user turn (parallel tool calls); strict role alternation otherwise. */
  static systemAndMessages(messages: Message[]): { system: string; msgs: any[] } {
    let system = "";
    const msgs: any[] = [];
    for (const m of messages) {
      if (m.role === "system") { system += (system ? "\n\n" : "") + m.content; continue; }
      if (m.role === "tool") {
        const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        const last = msgs[msgs.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) &&
            last.content.every((b: any) => b.type === "tool_result"))
          last.content.push(block);
        else msgs.push({ role: "user", content: [block] });
        continue;
      }
      if (m.role === "assistant") {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? [])
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        if (content.length) msgs.push({ role: "assistant", content });
        continue;
      }
      msgs.push({ role: "user", content: m.content });
    }
    return { system, msgs };
  }

  async *streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent> {
    const { system, msgs } = AnthropicClient.systemAndMessages(messages);
    const payload: any = {
      model: opts.model, max_tokens: opts.maxTokens, stream: true, messages: msgs,
    };
    if (system) payload.system = system;
    if (opts.temperature != null) payload.temperature = opts.temperature;
    if (tools.length)
      payload.tools = tools.map((t) => ({
        name: t.name, description: t.description, input_schema: t.parameters,
      }));

    const res = await postJson(`${this.baseUrl}/messages`, this.headers(), payload, opts.signal);
    const toolBuf = new Map<number, { id: string; name: string; json: string }>();
    let blockType = "";
    for await (const data of sseLines(res)) {
      const obj = safeParse(data);
      if (!obj) continue;
      switch (obj.type) {
        case "content_block_start":
          blockType = obj.content_block?.type ?? "";
          if (blockType === "tool_use")
            toolBuf.set(obj.index, { id: obj.content_block.id, name: obj.content_block.name, json: "" });
          break;
        case "content_block_delta": {
          const d = obj.delta;
          if (d?.type === "text_delta") yield { textDelta: d.text };
          else if (d?.type === "thinking_delta") yield { thinkingDelta: d.thinking };
          else if (d?.type === "input_json_delta" && toolBuf.has(obj.index))
            toolBuf.get(obj.index)!.json += d.partial_json;
          break;
        }
        case "message_delta":
          if (obj.usage)
            yield { usage: {
              prompt: obj.usage.input_tokens ?? 0,
              completion: obj.usage.output_tokens ?? 0,
            } };
          break;
        case "message_stop": {
          if (toolBuf.size) {
            const calls: ToolCall[] = [];
            for (const [, t] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
              let args: Record<string, unknown> = {};
              try { args = t.json ? JSON.parse(t.json) : {}; } catch { args = { _raw: t.json }; }
              calls.push({ id: t.id, name: t.name, arguments: args });
            }
            yield { toolCalls: calls };
          }
          break;
        }
        case "error":
          yield { error: obj.error?.message ?? "anthropic stream error" };
          break;
      }
    }
  }
}

// ---------- OpenAI Responses ----------

export class OpenAIResponsesClient implements ChatClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private authToken?: string,
    private extraHeaders?: Record<string, string>,
  ) {}

  private headers(): Record<string, string> {
    const auth = this.authToken
      ? { authorization: `Bearer ${this.authToken}` }
      : { authorization: `Bearer ${this.apiKey ?? ""}` };
    return { ...auth, ...(this.extraHeaders ?? {}) };
  }

  async *streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent> {
    const input: any[] = [];
    let instructions = "";
    for (const m of messages) {
      if (m.role === "system") { instructions += (instructions ? "\n\n" : "") + m.content; continue; }
      if (m.role === "tool") {
        input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        if (m.content) input.push({ role: "assistant", content: m.content });
        for (const tc of m.toolCalls)
          input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) });
        continue;
      }
      input.push({ role: m.role, content: m.content });
    }
    const payload: any = {
      model: opts.model, input, stream: true, max_output_tokens: opts.maxTokens,
    };
    if (instructions) payload.instructions = instructions;
    if (opts.temperature != null) payload.temperature = opts.temperature;
    if (tools.length)
      payload.tools = tools.map((t) => ({
        type: "function", name: t.name, description: t.description,
        parameters: t.parameters, strict: false,
      }));

    const res = await postJson(`${this.baseUrl}/responses`, this.headers(), payload, opts.signal);
    const calls = new Map<string, { id: string; name: string; args: string }>();
    for await (const data of sseLines(res)) {
      const obj = safeParse(data);
      if (!obj) continue;
      const type = obj.type ?? "";
      if (type === "response.output_text.delta") yield { textDelta: obj.delta };
      else if (type === "response.reasoning_summary_text.delta") yield { thinkingDelta: obj.delta };
      else if (type === "response.function_call_arguments.delta") {
        const key = String(obj.item_id ?? obj.output_index ?? 0);
        const cur = calls.get(key) ?? { id: obj.item_id ?? key, name: obj.name ?? "", args: "" };
        cur.args += obj.delta ?? "";
        if (obj.name) cur.name = obj.name;
        calls.set(key, cur);
      } else if (type === "response.completed" || type === "response.response.completed") {
        const out = obj.response?.output ?? [];
        const toolCalls: ToolCall[] = [];
        for (const item of out) {
          if (item.type === "function_call") {
            let args: Record<string, unknown> = {};
            try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch { args = { _raw: item.arguments }; }
            toolCalls.push({ id: item.call_id ?? item.id, name: item.name, arguments: args });
          }
        }
        if (toolCalls.length) yield { toolCalls };
        const u = obj.response?.usage;
        if (u) yield { usage: { prompt: u.input_tokens ?? 0, completion: u.output_tokens ?? 0 } };
      } else if (type === "response.failed" || type === "error") {
        yield { error: obj.response?.error?.message ?? obj.error?.message ?? "responses stream error" };
      }
    }
  }
}

// ---------- Gemini (API key + cloudcode-pa OAuth) ----------

export class GeminiClient implements ChatClient {
  cloudcode = false;
  private project: string | null = null;

  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private authToken?: string,
    private extraHeaders?: Record<string, string>,
  ) {
    this.cloudcode = baseUrl.includes("cloudcode-pa");
  }

  private headers(): Record<string, string> {
    const auth: Record<string, string> = this.authToken
      ? { authorization: `Bearer ${this.authToken}` }
      : { "x-goog-api-key": this.apiKey ?? "" };
    return { ...auth, ...(this.extraHeaders ?? {}) };
  }

  private async resolveProject(): Promise<string> {
    if (this.project !== null) return this.project;
    try {
      const res = await fetch(`${this.baseUrl}:loadCodeAssist`, {
        method: "POST", headers: this.headers(),
        body: JSON.stringify({ metadata: { pluginType: "gemini-vscode", ideType: "OTHER" } }),
      });
      const j: any = await res.json().catch(() => null);
      this.project = j?.cloudaicompanionProject?.id ?? j?.currentTier?.project ?? null;
    } catch {
      this.project = null;
    }
    return this.project ?? "";
  }

  static contentsAndSystem(messages: Message[]): { contents: any[]; system: string } {
    let system = "";
    const contents: any[] = [];
    for (const m of messages) {
      if (m.role === "system") { system += (system ? "\n\n" : "") + m.content; continue; }
      if (m.role === "tool") {
        const part = { functionResponse: { name: m.name ?? "", response: { output: m.content } } };
        const last = contents[contents.length - 1];
        if (last?.role === "user" && last.parts.every((p: any) => p.functionResponse)) last.parts.push(part);
        else contents.push({ role: "user", parts: [part] });
        continue;
      }
      if (m.role === "assistant") {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? [])
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        if (parts.length) contents.push({ role: "model", parts });
        continue;
      }
      contents.push({ role: "user", parts: [{ text: m.content }] });
    }
    return { contents, system };
  }

  async *streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent> {
    const { contents, system } = GeminiClient.contentsAndSystem(messages);
    const body: any = {
      contents,
      generationConfig: { maxOutputTokens: opts.maxTokens },
    };
    if (opts.temperature != null) body.generationConfig.temperature = opts.temperature;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length)
      body.tools = [{
        functionDeclarations: tools.map((t) => ({
          name: t.name, description: t.description, parameters: t.parameters,
        })),
      }];

    let url: string;
    let payload: any = body;
    if (this.cloudcode) {
      const project = await this.resolveProject();
      payload = { model: opts.model, project, request: body };
      url = `${this.baseUrl}:streamGenerateContent?alt=sse`;
    } else {
      url = `${this.baseUrl}/models/${opts.model}:streamGenerateContent?alt=sse&key=${this.apiKey ?? ""}`;
    }
    const res = await postJson(url, this.headers(), payload, opts.signal);
    const calls: ToolCall[] = [];
    for await (const data of sseLines(res)) {
      const obj = safeParse(data);
      if (!obj) continue;
      const inner = obj.request?.response ? obj : { response: obj };
      const resp = obj.response ?? obj;
      for (const cand of resp.candidates ?? []) {
        for (const part of cand.content?.parts ?? []) {
          if (part.text) yield { textDelta: part.text };
          if (part.functionCall)
            calls.push({
              id: `call_${calls.length}`, name: part.functionCall.name,
              arguments: part.functionCall.args ?? {},
            });
        }
      }
      if (resp.usageMetadata)
        yield { usage: {
          prompt: resp.usageMetadata.promptTokenCount ?? 0,
          completion: resp.usageMetadata.candidatesTokenCount ?? 0,
        } };
      if (obj.error) yield { error: obj.error.message ?? "gemini stream error" };
    }
    if (calls.length) yield { toolCalls: calls };
  }
}

// ---------- factory ----------

export function makeClient(
  format: string, baseUrl: string,
  opts: { apiKey?: string; authToken?: string; extraHeaders?: Record<string, string> },
): ChatClient {
  switch (format) {
    case "claude":
      return new AnthropicClient(baseUrl, opts.apiKey, opts.authToken, opts.extraHeaders);
    case "openai-responses":
      return new OpenAIResponsesClient(baseUrl, opts.apiKey, opts.authToken, opts.extraHeaders);
    case "gemini":
    case "gemini-oauth":
      return new GeminiClient(baseUrl, opts.apiKey, opts.authToken, opts.extraHeaders);
    default:
      return new OpenAIChatClient(baseUrl, opts.apiKey ?? opts.authToken, opts.extraHeaders);
  }
}
