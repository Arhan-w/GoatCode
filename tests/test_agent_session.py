"""Agent loop end-to-end against a fake client + session persistence."""
from __future__ import annotations

from pathlib import Path

import pytest

from goatcode.agent import Agent, AgentEvent, model_id
from goatcode.llm import Message, StreamEvent, ToolCall
from goatcode.session import Session, list_sessions, summarize
from goatcode.tools import ToolKit


class FakeClient:
    """Scripted stream_chat: each entry is a list of StreamEvents for one turn."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.calls = []

    async def stream_chat(self, messages, tools, *, model, max_tokens=4096, temperature=None):
        self.calls.append([m.role for m in messages])
        events = self.turns.pop(0) if self.turns else [StreamEvent(text_delta="done")]
        for ev in events:
            yield ev


@pytest.fixture
def session(tmp_path):
    s = Session.new(str(tmp_path), "fake/model-x")
    return s


async def drain(agent, text):
    return [ev async for ev in agent.run_turn(text)]


@pytest.mark.asyncio
async def test_plain_text_turn(session, tmp_path):
    client = FakeClient([[StreamEvent(text_delta="2 + 2 = "), StreamEvent(text_delta="4")]])
    agent = Agent(client=client, session=session, tools=ToolKit(tmp_path, auto_approve=True))
    events = await drain(agent, "math?")
    assert "".join(e.text for e in events if e.kind == "text") == "2 + 2 = 4"
    assert events[-1].kind == "done"
    assert session.messages[-1].content == "2 + 2 = 4"


@pytest.mark.asyncio
async def test_tool_roundtrip(session, tmp_path):
    (tmp_path / "f.txt").write_text("secret content", encoding="utf-8")
    client = FakeClient([
        [StreamEvent(tool_calls=[ToolCall("c1", "read", {"path": "f.txt"})])],
        [StreamEvent(text_delta="it says secret")],
    ])
    agent = Agent(client=client, session=session, tools=ToolKit(tmp_path, auto_approve=True))
    events = await drain(agent, "read f")
    kinds = [e.kind for e in events]
    assert "tool_start" in kinds and "tool_end" in kinds
    tool_msg = [m for m in session.messages if m.role == "tool"][0]
    assert "secret content" in tool_msg.content
    assert "it says secret" in events[-2].text or any("it says secret" in e.text for e in events)
    # second call included the tool result in history
    assert "tool" in client.calls[1]


@pytest.mark.asyncio
async def test_error_stops_turn(session, tmp_path):
    client = FakeClient([[StreamEvent(error="HTTP 401: bad key")]])
    agent = Agent(client=client, session=session, tools=ToolKit(tmp_path, auto_approve=True))
    events = await drain(agent, "hi")
    assert events[-1].kind == "error"
    assert "401" in events[-1].text


@pytest.mark.asyncio
async def test_max_steps_guard(session, tmp_path):
    endless = [[StreamEvent(tool_calls=[ToolCall("c", "glob", {"pattern": "*"})])]
               for _ in range(5)]
    client = FakeClient(endless)
    agent = Agent(client=client, session=session, tools=ToolKit(tmp_path, auto_approve=True),
                  max_steps=3)
    events = await drain(agent, "loop")
    assert events[-1].kind == "error" and "max_steps" in events[-1].text


@pytest.mark.asyncio
async def test_session_persistence_roundtrip(session, tmp_path):
    session.title = "hello task"
    session.append(Message("user", "hi"))
    session.append(Message("assistant", "yo", tool_calls=[ToolCall("c1", "read", {"path": "x"})]))
    session.save()
    loaded = Session.load(session.id)
    assert loaded.title == "hello task"
    assert loaded.messages[1].tool_calls[0].name == "read"
    rows = list_sessions()
    assert any(r["id"] == session.id for r in rows)


@pytest.mark.asyncio
async def test_denied_tool_feeds_error_back(session, tmp_path):
    client = FakeClient([
        [StreamEvent(tool_calls=[ToolCall("c1", "write", {"path": "x.txt", "content": "nope"})])],
        [StreamEvent(text_delta="ok skipping")],
    ])
    tools = ToolKit(tmp_path, auto_approve=False, permission=lambda t, a: False)
    agent = Agent(client=client, session=session, tools=tools)
    events = await drain(agent, "write x")
    tool_msg = [m for m in session.messages if m.role == "tool"][0]
    assert "denied" in tool_msg.content
    assert not (tmp_path / "x.txt").exists()


def test_model_id_split():
    s = Session.new("/tmp", "openrouter/deepseek-ai/deepseek-v3.2")
    assert model_id(s) == "deepseek-ai/deepseek-v3.2"
    s2 = Session.new("/tmp", "bare-model")
    assert model_id(s2) == "bare-model"


def test_summarize_digests_recent():
    msgs = [Message("user", "first thing"), Message("assistant", "second thing"),
            Message("tool", "ignored")]
    text = summarize(msgs)
    assert "first thing" in text and "ignored" not in text


@pytest.mark.asyncio
async def test_compaction_moves_window(session, tmp_path):
    from goatcode.agent import COMPACT_TRIGGER_CHARS

    client = FakeClient([[StreamEvent(tool_calls=[ToolCall("c", "glob", {"pattern": "*"})]),
                         StreamEvent(text_delta="")],
                        [StreamEvent(text_delta="fin")]])
    agent = Agent(client=client, session=session, tools=ToolKit(tmp_path, auto_approve=True))
    filler = "x" * (COMPACT_TRIGGER_CHARS // 20)
    for i in range(25):
        session.append(Message("user", f"{filler}{i}"))
    assert session.compacted_from == 0
    await drain(agent, "go")
    assert session.compacted_from > 0
    # context() skips the compacted prefix
    assert len(session.context()) < len(session.messages)


@pytest.mark.asyncio
async def test_compaction_never_starts_on_tool_result(session, tmp_path):
    """A window opening on a tool message orphans its parent tool_calls -> 400.

    Crafted so the naive cut (L - max(8, L//3)) lands exactly on a tool msg:
    19 fillers + assistant(tc) + tool + 9 trailing = 30 msgs, cut = 20 = tool.
    """
    from goatcode.agent import COMPACT_TRIGGER_CHARS

    filler = "z" * (COMPACT_TRIGGER_CHARS // 10)
    for i in range(19):
        session.append(Message("user", f"{filler}{i}"))
    session.append(Message("assistant", "", tool_calls=[ToolCall("z", "glob", {"pattern": "*"})]))
    session.append(Message("tool", "result text", tool_call_id="z", name="glob"))
    for i in range(9):
        session.append(Message("user", f"{filler}t{i}"))
    assert len(session.messages) == 30
    assert session.messages[20].role == "tool"  # the naive cut target

    client = FakeClient([])
    agent = Agent(client=client, session=session, tools=ToolKit(tmp_path, auto_approve=True))
    agent._maybe_compact()
    assert session.compacted_from == 21  # advanced past the orphaned tool result
    assert session.messages[session.compacted_from].role != "tool"
