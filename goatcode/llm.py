"""LLM protocol adapters: normalize chat + tool calls across API formats.

Formats: openai (chat/completions), claude (messages), openai-responses, gemini.
Streaming yields deltas; non-streaming returns one final response.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import httpx


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Message:
    role: str                       # system | user | assistant | tool
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None  # for role=tool results
    name: str | None = None


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class ChatResponse:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = "end"        # end | tool_use | max_tokens | error
    usage: dict[str, int] = field(default_factory=dict)
    error: str | None = None


@dataclass
class StreamEvent:
    """One streamed chunk: text delta, completed tool calls, or final usage."""
    text_delta: str = ""
    tool_calls: list[ToolCall] | None = None
    usage: dict[str, int] | None = None
    error: str | None = None


class LLMError(Exception):
    pass


async def _sse_lines(response: httpx.Response) -> Any:
    """Yield parsed SSE data payloads from an httpx streaming response."""
    async for line in response.aiter_lines():
        if not line:
            continue
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload in ("[DONE]", ""):
                continue
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                continue


class BaseClient:
    def __init__(self, base_url: str, headers: dict[str, str], timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = headers
        self.timeout = timeout

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self.timeout, headers=self.headers)


class OpenAIChatClient(BaseClient):
    """OpenAI-compatible /chat/completions — also serves 180+ catalog providers."""

    def __init__(self, base_url: str, api_key: str | None, timeout: float = 120.0,
                 extra_headers: dict[str, str] | None = None) -> None:
        headers = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        headers.update(extra_headers or {})
        super().__init__(base_url, headers, timeout)

    def _body(self, messages: list[Message], tools: list[ToolSpec], model: str,
              max_tokens: int, temperature: float | None, stream: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model, "max_tokens": max_tokens, "stream": stream,
        }
        if temperature is not None:
            body["temperature"] = temperature
        payload: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "tool":
                payload.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
            elif m.role == "assistant" and m.tool_calls:
                payload.append({
                    "role": "assistant", "content": m.content or None,
                    "tool_calls": [{
                        "id": tc.id, "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                    } for tc in m.tool_calls],
                })
            else:
                payload.append({"role": m.role, "content": m.content})
        body["messages"] = payload
        if tools:
            body["tools"] = [{
                "type": "function",
                "function": {"name": t.name, "description": t.description,
                             "parameters": t.parameters},
            } for t in tools]
        return body

    async def stream_chat(self, messages: list[Message], tools: list[ToolSpec], *,
                          model: str, max_tokens: int = 4096,
                          temperature: float | None = None) -> AsyncIterator[StreamEvent]:
        body = self._body(messages, tools, model, max_tokens, temperature, stream=True)
        tool_acc: dict[int, dict[str, str]] = {}
        async with self._client() as client:
            async with client.stream("POST", f"{self.base_url}/chat/completions", json=body) as resp:
                if resp.status_code >= 400:
                    text = (await resp.aread()).decode(errors="replace")[:600]
                    yield StreamEvent(error=f"HTTP {resp.status_code}: {text}")
                    return
                async for chunk in _sse_lines(resp):
                    choices = chunk.get("choices") or []
                    if not choices:
                        if usage := chunk.get("usage"):
                            yield StreamEvent(usage={
                                "prompt": usage.get("prompt_tokens", 0),
                                "completion": usage.get("completion_tokens", 0)})
                        continue
                    delta = choices[0].get("delta") or {}
                    if content := delta.get("content"):
                        yield StreamEvent(text_delta=content)
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index", 0)
                        slot = tool_acc.setdefault(idx, {"id": "", "name": "", "args": ""})
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = fn["name"]
                        if fn.get("arguments"):
                            slot["args"] += fn["arguments"]
                    if choices[0].get("finish_reason") == "tool_calls" and tool_acc:
                        calls = []
                        for slot in tool_acc.values():
                            try:
                                args = json.loads(slot["args"] or "{}")
                            except json.JSONDecodeError:
                                args = {"_raw": slot["args"]}
                            calls.append(ToolCall(id=slot["id"] or f"call_{len(calls)}",
                                                  name=slot["name"], arguments=args))
                        yield StreamEvent(tool_calls=calls)


class AnthropicClient(BaseClient):
    """Anthropic /v1/messages (works with API keys and OAuth bearer tokens)."""

    def __init__(self, base_url: str, api_key: str | None = None,
                 auth_token: str | None = None, timeout: float = 120.0) -> None:
        headers = {"content-type": "application/json", "anthropic-version": "2023-06-01"}
        if auth_token:
            headers["authorization"] = f"Bearer {auth_token}"
            headers["anthropic-beta"] = "oauth-2025-04-20"
        elif api_key:
            headers["x-api-key"] = api_key
        super().__init__(base_url, headers, timeout)

    def _system_and_messages(self, messages: list[Message]) -> tuple[str, list[dict[str, Any]]]:
        system = ""
        payload: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "system":
                system = (system + "\n" + m.content).strip()
            elif m.role == "tool":
                block = {"type": "tool_result", "tool_use_id": m.tool_call_id,
                         "content": m.content}
                # Anthropic requires all tool_results for one assistant turn in
                # a SINGLE user message; consecutive same-role turns are a 400.
                if payload and payload[-1]["role"] == "user" and isinstance(
                        payload[-1]["content"], list) and payload[-1]["content"] \
                        and payload[-1]["content"][0].get("type") == "tool_result":
                    payload[-1]["content"].append(block)
                else:
                    payload.append({"role": "user", "content": [block]})
            elif m.role == "assistant" and m.tool_calls:
                blocks: list[dict[str, Any]] = []
                if m.content:
                    blocks.append({"type": "text", "text": m.content})
                for tc in m.tool_calls:
                    blocks.append({"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments})
                payload.append({"role": "assistant", "content": blocks})
            else:
                payload.append({"role": "user", "content": m.content})
        return system, payload

    async def stream_chat(self, messages: list[Message], tools: list[ToolSpec], *,
                          model: str, max_tokens: int = 4096,
                          temperature: float | None = None) -> AsyncIterator[StreamEvent]:
        system, payload = self._system_and_messages(messages)
        body: dict[str, Any] = {"model": model, "max_tokens": max_tokens,
                                "messages": payload, "stream": True}
        if system:
            body["system"] = system
        if temperature is not None:
            body["temperature"] = temperature
        if tools:
            body["tools"] = [{"name": t.name, "description": t.description,
                              "input_schema": t.parameters} for t in tools]
        tool_blocks: dict[int, dict[str, Any]] = {}
        async with self._client() as client:
            async with client.stream("POST", f"{self.base_url}/messages", json=body) as resp:
                if resp.status_code >= 400:
                    text = (await resp.aread()).decode(errors="replace")[:600]
                    yield StreamEvent(error=f"HTTP {resp.status_code}: {text}")
                    return
                async for chunk in _sse_lines(resp):
                    ctype = chunk.get("type")
                    if ctype == "content_block_start":
                        block = chunk.get("content_block") or {}
                        if block.get("type") == "tool_use":
                            tool_blocks[chunk["index"]] = {
                                "id": block.get("id", ""), "name": block.get("name", ""), "json": ""}
                    elif ctype == "content_block_delta":
                        delta = chunk.get("delta") or {}
                        if delta.get("type") == "text_delta" and delta.get("text"):
                            yield StreamEvent(text_delta=delta["text"])
                        elif delta.get("type") == "input_json_delta":
                            slot = tool_blocks.get(chunk["index"])
                            if slot:
                                slot["json"] += delta.get("partial_json", "")
                    elif ctype == "message_delta":
                        usage = chunk.get("usage") or {}
                        if usage:
                            yield StreamEvent(usage={
                                "prompt": usage.get("input_tokens", 0),
                                "completion": usage.get("output_tokens", 0)})
                    elif ctype == "message_stop" and tool_blocks:
                        calls = []
                        for slot in tool_blocks.values():
                            try:
                                args = json.loads(slot["json"] or "{}")
                            except json.JSONDecodeError:
                                args = {"_raw": slot["json"]}
                            calls.append(ToolCall(id=slot["id"], name=slot["name"], arguments=args))
                        yield StreamEvent(tool_calls=calls)


class OpenAIResponsesClient(BaseClient):
    """OpenAI /v1/responses (used by Codex OAuth and native OpenAI)."""

    def __init__(self, base_url: str, api_key: str | None = None,
                 auth_token: str | None = None, timeout: float = 120.0,
                 extra_headers: dict[str, str] | None = None) -> None:
        headers = {"content-type": "application/json"}
        token = auth_token or api_key
        if token:
            headers["authorization"] = f"Bearer {token}"
        headers.update(extra_headers or {})
        super().__init__(base_url, headers, timeout)

    async def stream_chat(self, messages: list[Message], tools: list[ToolSpec], *,
                          model: str, max_tokens: int = 4096,
                          temperature: float | None = None) -> AsyncIterator[StreamEvent]:
        input_items: list[dict[str, Any]] = []
        instructions = ""
        for m in messages:
            if m.role == "system":
                instructions = (instructions + "\n" + m.content).strip()
            elif m.role == "tool":
                input_items.append({"type": "function_call_output",
                                    "call_id": m.tool_call_id, "output": m.content})
            elif m.role == "assistant" and m.tool_calls:
                for tc in m.tool_calls:
                    input_items.append({"type": "function_call", "call_id": tc.id,
                                        "name": tc.name, "arguments": json.dumps(tc.arguments)})
                if m.content:
                    input_items.append({"role": "assistant", "content": m.content})
            else:
                input_items.append({"role": m.role, "content": m.content})
        body: dict[str, Any] = {"model": model, "input": input_items, "stream": True}
        if instructions:
            body["instructions"] = instructions
        if tools:
            body["tools"] = [{"type": "function", "name": t.name, "description": t.description,
                              "parameters": t.parameters} for t in tools]
        calls: dict[str, ToolCall] = {}
        async with self._client() as client:
            async with client.stream("POST", f"{self.base_url}/responses", json=body) as resp:
                if resp.status_code >= 400:
                    text = (await resp.aread()).decode(errors="replace")[:600]
                    yield StreamEvent(error=f"HTTP {resp.status_code}: {text}")
                    return
                async for chunk in _sse_lines(resp):
                    ctype = chunk.get("type", "")
                    if ctype == "response.output_text.delta":
                        yield StreamEvent(text_delta=chunk.get("delta", ""))
                    elif ctype == "response.function_call_arguments.delta":
                        cid = chunk.get("item_id", "")
                        slot = calls.setdefault(cid, ToolCall(id=cid, name=chunk.get("name", ""), arguments={}))
                        slot.arguments.setdefault("_acc", "")
                        slot.arguments["_acc"] += chunk.get("delta", "")
                    elif ctype == "response.output_item.done":
                        item = chunk.get("item") or {}
                        if item.get("type") == "function_call":
                            cid = item.get("call_id") or item.get("id", "")
                            try:
                                args = json.loads(item.get("arguments") or "{}")
                            except json.JSONDecodeError:
                                args = {}
                            calls[cid] = ToolCall(id=cid, name=item.get("name", ""), arguments=args)
                    elif ctype == "response.completed":
                        usage = (chunk.get("response") or {}).get("usage") or {}
                        if usage:
                            yield StreamEvent(usage={
                                "prompt": usage.get("input_tokens", 0),
                                "completion": usage.get("output_tokens", 0)})
                        if calls:
                            final = []
                            for k, c in calls.items():
                                args = c.arguments
                                if set(args) == {"_acc"}:
                                    try:
                                        args = json.loads(args["_acc"] or "{}")
                                    except json.JSONDecodeError:
                                        args = {"_raw": args["_acc"]}
                                args = {kk: vv for kk, vv in args.items() if kk != "_acc"}
                                final.append(ToolCall(id=c.id or k, name=c.name, arguments=args))
                            yield StreamEvent(tool_calls=final)


class GeminiClient(BaseClient):
    """Google Generative Language API with function calling.

    `cloudcode=True` switches to the Code Assist (cloudcode-pa) shape used by
    Gemini OAuth: bearer auth, body wrapped under "request", project resolved
    via loadCodeAssist on first call.
    """

    def __init__(self, base_url: str, api_key: str | None = None,
                 auth_token: str | None = None, timeout: float = 120.0,
                 cloudcode: bool = False) -> None:
        headers = {"content-type": "application/json"}
        self.api_key = api_key
        self.auth_token = auth_token
        self.cloudcode = cloudcode
        self._project: str | None = None
        if auth_token:
            headers["authorization"] = f"Bearer {auth_token}"
        super().__init__(base_url, headers, timeout)

    def _url(self, model: str) -> str:
        if self.cloudcode:
            return f"{self.base_url}:streamGenerateContent?alt=sse"
        action = "streamGenerateContent?alt=sse"
        url = f"{self.base_url}/{model}:{action}"
        if self.api_key:
            url += f"&key={self.api_key}"
        return url

    async def _resolve_project(self, client: httpx.AsyncClient) -> str:
        if self._project is None:
            try:
                resp = await client.post(f"{self.base_url}:loadCodeAssist",
                                         json={"cloudaicompanionProject": ""})
                self._project = (resp.json().get("cloudaicompanionProject")
                                 or "goatcode") if resp.status_code < 400 else "goatcode"
            except Exception:  # noqa: BLE001
                self._project = "goatcode"
        return self._project

    def _contents_and_system(self, messages: list[Message]) -> tuple[str, list[dict[str, Any]]]:
        contents: list[dict[str, Any]] = []
        system = ""
        for m in messages:
            if m.role == "system":
                system = (system + "\n" + m.content).strip()
            elif m.role == "tool":
                block = {"functionResponse": {"name": m.name or "tool",
                                              "response": {"result": m.content}}}
                # Gemini requires strict user/model alternation — merge
                # consecutive tool results into one user turn.
                if contents and contents[-1]["role"] == "user" and isinstance(
                        contents[-1]["content"], list):
                    contents[-1]["content"].append(block)
                else:
                    contents.append({"role": "user", "content": [block]})
            elif m.role == "assistant" and m.tool_calls:
                parts = [{"text": m.content}] if m.content else []
                parts += [{"functionCall": {"name": tc.name, "args": tc.arguments}}
                          for tc in m.tool_calls]
                contents.append({"role": "model", "content": parts})
            else:
                contents.append({"role": "user", "content": m.content})
        return system, contents

    async def stream_chat(self, messages: list[Message], tools: list[ToolSpec], *,
                          model: str, max_tokens: int = 4096,
                          temperature: float | None = None) -> AsyncIterator[StreamEvent]:
        system, contents = self._contents_and_system(messages)
        body: dict[str, Any] = {"contents": contents,
                                "generationConfig": {"maxOutputTokens": max_tokens}}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if temperature is not None:
            body["generationConfig"]["temperature"] = temperature
        if tools:
            body["tools"] = [{"functionDeclarations": [{
                "name": t.name, "description": t.description,
                "parameters": _strip_json_schema(t.parameters)} for t in tools]}]
        async with self._client() as client:
            if self.cloudcode:
                project = await self._resolve_project(client)
                body = {"model": model, "project": project, "request": body}
            async with client.stream("POST", self._url(model), json=body) as resp:
                if resp.status_code >= 400:
                    text = (await resp.aread()).decode(errors="replace")[:600]
                    yield StreamEvent(error=f"HTTP {resp.status_code}: {text}")
                    return
                calls: list[ToolCall] = []
                async for chunk in _sse_lines(resp):
                    cand = (chunk.get("candidates") or [{}])[0]
                    for part in (cand.get("content") or {}).get("parts") or []:
                        if text := part.get("text"):
                            yield StreamEvent(text_delta=text)
                        if fc := part.get("functionCall"):
                            calls.append(ToolCall(id=fc.get("id") or f"call_{len(calls)}",
                                                  name=fc.get("name", ""), arguments=fc.get("args") or {}))
                    if usage := chunk.get("usageMetadata"):
                        yield StreamEvent(usage={
                            "prompt": usage.get("promptTokenCount", 0),
                            "completion": usage.get("candidatesTokenCount", 0)})
                    if cand.get("finishReason") and calls:
                        yield StreamEvent(tool_calls=calls)
                        calls = []


def _strip_json_schema(params: dict[str, Any]) -> dict[str, Any]:
    """Gemini rejects some JSON Schema keywords ($schema, additionalProperties)."""
    cleaned = dict(params)
    for key in ("$schema", "additionalProperties", "$defs", "definitions"):
        cleaned.pop(key, None)
    return cleaned


def make_client(fmt: str, base_url: str, *, api_key: str | None = None,
                auth_token: str | None = None, timeout: float = 120.0,
                extra_headers: dict[str, str] | None = None) -> Any:
    if fmt == "claude":
        return AnthropicClient(base_url, api_key=api_key, auth_token=auth_token, timeout=timeout)
    if fmt == "openai-responses":
        return OpenAIResponsesClient(base_url, api_key=api_key, auth_token=auth_token,
                                     timeout=timeout, extra_headers=extra_headers)
    if fmt == "gemini":
        return GeminiClient(base_url, api_key=api_key, auth_token=auth_token, timeout=timeout)
    if fmt == "gemini-oauth":
        return GeminiClient(base_url, auth_token=auth_token, timeout=timeout, cloudcode=True)
    return OpenAIChatClient(base_url, api_key=api_key, timeout=timeout, extra_headers=extra_headers)
