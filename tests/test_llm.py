"""Protocol adapters against mocked SSE streams (no network)."""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from goatcode.llm import (
    AnthropicClient,
    GeminiClient,
    Message,
    OpenAIChatClient,
    OpenAIResponsesClient,
    ToolCall,
    ToolSpec,
    make_client,
)


def sse(events: list[dict[str, Any]]) -> bytes:
    return b"".join(f"data: {json.dumps(e)}\n\n".encode() for e in events)


def handler(body: bytes, captured: dict) -> httpx.Response:
    def _h(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})
    return _h


def client_with_transport(client, body: bytes, captured: dict):
    transport = httpx.MockTransport(handler(body, captured))
    client._client = lambda: httpx.AsyncClient(transport=transport, headers=client.headers)
    return client


TOOLS = [ToolSpec("read", "read a file", {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]})]


async def collect(agen):
    out = []
    async for ev in agen:
        out.append(ev)
    return out


# ---------- OpenAI chat ----------

@pytest.mark.asyncio
async def test_openai_chat_text_stream():
    c = OpenAIChatClient("https://api.test/v1", "sk-x")
    body = sse([
        {"choices": [{"delta": {"content": "Hello"}}]},
        {"choices": [{"delta": {"content": " world"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 5, "completion_tokens": 2}},
    ])
    cap: dict = {}
    client_with_transport(c, body, cap)
    events = await collect(c.stream_chat([Message("user", "hi")], TOOLS, model="gpt-test"))
    text = "".join(e.text_delta for e in events)
    assert text == "Hello world"
    assert any(e.usage == {"prompt": 5, "completion": 2} for e in events)
    sent = json.loads(cap["request"].content)
    assert sent["model"] == "gpt-test" and sent["stream"] is True
    assert sent["tools"][0]["function"]["name"] == "read"


@pytest.mark.asyncio
async def test_openai_chat_tool_call_reassembly():
    c = OpenAIChatClient("https://api.test/v1", "sk-x")
    body = sse([
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "call_1", "function": {"name": "read", "arguments": '{"pa'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": 'th": "a.txt"}'}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ])
    events = await collect(client_with_transport(c, body, {}).stream_chat(
        [Message("user", "read")], TOOLS, model="m"))
    calls = [e.tool_calls for e in events if e.tool_calls]
    assert calls and calls[0][0].name == "read"
    assert calls[0][0].arguments == {"path": "a.txt"}


@pytest.mark.asyncio
async def test_openai_chat_error_surfaces():
    c = OpenAIChatClient("https://api.test/v1", "sk-x")
    transport = httpx.MockTransport(lambda req: httpx.Response(429, content=b"rate limited"))
    c._client = lambda: httpx.AsyncClient(transport=transport)
    events = await collect(c.stream_chat([Message("user", "hi")], [], model="m"))
    assert events[0].error and "429" in events[0].error


@pytest.mark.asyncio
async def test_openai_chat_history_shape():
    c = OpenAIChatClient("https://api.test/v1", "sk-x")
    cap: dict = {}
    client_with_transport(c, sse([]), cap)
    msgs = [
        Message("assistant", "reading", tool_calls=[ToolCall("c1", "read", {"path": "x"})]),
        Message("tool", "contents here", tool_call_id="c1"),
    ]
    await collect(c.stream_chat(msgs, [], model="m"))
    sent = json.loads(cap["request"].content)["messages"]
    assert sent[0]["tool_calls"][0]["id"] == "c1"
    assert sent[1] == {"role": "tool", "tool_call_id": "c1", "content": "contents here"}


# ---------- Anthropic ----------

@pytest.mark.asyncio
async def test_anthropic_text_and_tools():
    c = AnthropicClient("https://api.anthropic.com/v1", api_key="sk-ant")
    body = sse([
        {"type": "message_start", "message": {}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}},
        {"type": "content_block_start", "index": 1,
         "content_block": {"type": "tool_use", "id": "tu_1", "name": "read"}},
        {"type": "content_block_delta", "index": 1,
         "delta": {"type": "input_json_delta", "partial_json": '{"path": "a"}'}},
        {"type": "message_delta", "usage": {"input_tokens": 3, "output_tokens": 4}},
        {"type": "message_stop"},
    ])
    cap: dict = {}
    events = await collect(client_with_transport(c, body, cap).stream_chat(
        [Message("system", "sys prompt"), Message("user", "go")], TOOLS, model="claude-x"))
    assert "".join(e.text_delta for e in events) == "hi"
    calls = [tc for e in events if e.tool_calls for tc in e.tool_calls]
    assert calls[0].id == "tu_1" and calls[0].arguments == {"path": "a"}
    sent = json.loads(cap["request"].content)
    assert sent["system"] == "sys prompt"
    assert sent["tools"][0]["input_schema"]["type"] == "object"
    assert cap["request"].headers["x-api-key"] == "sk-ant"


@pytest.mark.asyncio
async def test_anthropic_oauth_bearer_header():
    c = AnthropicClient("https://api.anthropic.com/v1", auth_token="oauth-tok")
    assert c.headers["authorization"] == "Bearer oauth-tok"
    assert "oauth-2025-04-20" in c.headers["anthropic-beta"]


@pytest.mark.asyncio
async def test_anthropic_tool_result_maps_to_user():
    c = AnthropicClient("https://x/v1", api_key="k")
    system, payload = c._system_and_messages([
        Message("assistant", "", tool_calls=[ToolCall("t1", "read", {})]),
        Message("tool", "RESULT", tool_call_id="t1"),
    ])
    assert payload[1]["content"][0]["type"] == "tool_result"
    assert payload[1]["content"][0]["tool_use_id"] == "t1"


def test_anthropic_parallel_tool_results_merge_into_one_user_turn():
    """Two tool results for one assistant turn must share a single user message,
    or the API 400s on the next request."""
    c = AnthropicClient("https://x/v1", api_key="k")
    _, payload = c._system_and_messages([
        Message("assistant", "", tool_calls=[ToolCall("t1", "read", {}), ToolCall("t2", "glob", {})]),
        Message("tool", "R1", tool_call_id="t1"),
        Message("tool", "R2", tool_call_id="t2"),
    ])
    assert payload[1]["role"] == "user"
    assert [b["tool_use_id"] for b in payload[1]["content"]] == ["t1", "t2"]
    roles = [p["role"] for p in payload]
    assert all(a != b for a, b in zip(roles, roles[1:])), "consecutive same-role turns"


def test_gemini_parallel_tool_results_merge():
    from goatcode.llm import GeminiClient
    c = GeminiClient("https://x/v1beta/models", api_key="k")
    _, contents = c._contents_and_system([
        Message("assistant", "", tool_calls=[ToolCall("t1", "read", {}), ToolCall("t2", "glob", {})]),
        Message("tool", "R1", tool_call_id="t1", name="read"),
        Message("tool", "R2", tool_call_id="t2", name="glob"),
    ])
    assert contents[-1]["role"] == "user"
    assert len(contents[-1]["content"]) == 2
    roles = [x["role"] for x in contents]
    assert all(a != b for a, b in zip(roles, roles[1:]))


def test_system_messages_concatenate_not_overwrite():
    """agent._messages() emits base prompt + compaction digest as two system
    messages; clients must keep both."""
    msgs = [Message("system", "BASE"), Message("system", "DIGEST"), Message("user", "hi")]
    system, _ = AnthropicClient("https://x/v1", api_key="k")._system_and_messages(msgs)
    assert "BASE" in system and "DIGEST" in system
    gsys, _ = GeminiClient("https://x/v1beta/models", api_key="k")._contents_and_system(msgs)
    assert "BASE" in gsys and "DIGEST" in gsys


# ---------- Responses API ----------

@pytest.mark.asyncio
async def test_responses_stream():
    c = OpenAIResponsesClient("https://api.test/v1", api_key="sk")
    body = sse([
        {"type": "response.output_text.delta", "delta": "yo"},
        {"type": "response.output_item.done", "item": {
            "type": "function_call", "call_id": "cx", "name": "read",
            "arguments": '{"path":"p"}'}},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 2}}},
    ])
    events = await collect(client_with_transport(c, body, {}).stream_chat(
        [Message("user", "hi")], TOOLS, model="gpt-5"))
    assert "".join(e.text_delta for e in events) == "yo"
    calls = [tc for e in events if e.tool_calls for tc in e.tool_calls]
    assert calls[0].name == "read" and calls[0].arguments == {"path": "p"}


# ---------- Gemini ----------

@pytest.mark.asyncio
async def test_gemini_stream():
    c = GeminiClient("https://generativelanguage.googleapis.com/v1beta/models", api_key="gk")
    body = sse([
        {"candidates": [{"content": {"parts": [{"text": "hey"}]}}]},
        {"candidates": [{"content": {"parts": [
            {"functionCall": {"name": "read", "args": {"path": "z"}}}]},
            "finishReason": "STOP"}]},
        {"usageMetadata": {"promptTokenCount": 2, "candidatesTokenCount": 3}},
    ])
    cap: dict = {}
    events = await collect(client_with_transport(c, body, cap).stream_chat(
        [Message("user", "hi")], TOOLS, model="gemini-3-flash"))
    assert "".join(e.text_delta for e in events) == "hey"
    calls = [tc for e in events if e.tool_calls for tc in e.tool_calls]
    assert calls[0].name == "read"
    assert "key=gk" in str(cap["request"].url)
    sent = json.loads(cap["request"].content)
    assert "functionDeclarations" in sent["tools"][0]
    assert "$schema" not in sent["tools"][0]["functionDeclarations"][0]["parameters"]


def test_make_client_dispatch():
    assert isinstance(make_client("openai", "https://a"), OpenAIChatClient)
    assert isinstance(make_client("claude", "https://a"), AnthropicClient)
    assert isinstance(make_client("openai-responses", "https://a"), OpenAIResponsesClient)
    assert isinstance(make_client("gemini", "https://a"), GeminiClient)
    # unknown format falls back to openai-compatible (the widest door)
    assert isinstance(make_client("weird", "https://a"), OpenAIChatClient)
