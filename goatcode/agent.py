"""The agent loop: prompt -> stream -> tool calls -> results -> repeat.

Model-agnostic: one ChatClient interface (from llm.make_client) behind every
provider. Events are yielded so the TUI can render incrementally without
holding the whole transcript in memory.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

from .llm import ChatResponse, LLMError, Message, StreamEvent
from .session import Session, summarize
from .tools import ToolKit

SYSTEM_PROMPT = """\
You are GoatCode, a precise terminal coding agent running on the user's machine.

Rules:
- Act on the request; don't restate it. Show conclusions through tool results, not narration.
- Prefer read/grep/glob before editing. Never guess file contents.
- edit requires an exact unique old_string. If it fails, read the file and retry.
- Keep bash commands non-interactive. Quote paths with spaces.
- When done, give a 1-3 line summary: what changed, what to verify.
- If the task is ambiguous and risky (deletes, pushes, money), ask first.

Environment:
- Working directory: {cwd}
- Platform: {platform}
- Python: {pyver}
"""

# Rough char budget before compaction kicks in (≈ chars/4 tokens).
COMPACT_TRIGGER_CHARS = 220_000


@dataclass
class AgentEvent:
    kind: str                     # text | tool_start | tool_end | usage | error | done | compact
    text: str = ""
    tool: str = ""
    args: dict[str, Any] | None = None
    result: str = ""
    ok: bool = True


def build_system_prompt(root: Path) -> str:
    return SYSTEM_PROMPT.format(
        cwd=root, platform=sys.platform, pyver=f"{sys.version_info.major}.{sys.version_info.minor}",
    )


class Agent:
    def __init__(self, *, client: Any, session: Session, tools: ToolKit,
                 max_tokens: int = 8192, temperature: float | None = None,
                 max_steps: int = 40) -> None:
        self.client = client
        self.session = session
        self.tools = tools
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.max_steps = max_steps

    def _messages(self) -> list[Message]:
        ctx = self.session.context()
        msgs = [Message("system", build_system_prompt(Path(self.session.cwd)))]
        if self.session.compacted_from:
            msgs.append(Message("system", summarize(self.session.messages[:self.session.compacted_from])))
        msgs.extend(ctx)
        return msgs

    async def run_turn(self, user_text: str) -> AsyncIterator[AgentEvent]:
        self.session.append(Message("user", user_text))
        if not self.session.title:
            self.session.title = user_text.strip().splitlines()[0][:80] if user_text.strip() else "session"
        steps = 0
        while steps < self.max_steps:
            steps += 1
            response = ChatResponse()
            async for ev in self._stream_once():
                if isinstance(ev, AgentEvent):
                    yield ev
                    if ev.kind == "error":
                        return
                    continue
                # raw StreamEvent below
                if ev.error:
                    self.session.append(Message("assistant", f"[provider error] {ev.error}"))
                    yield AgentEvent("error", text=ev.error)
                    return
                if ev.text_delta:
                    response.text += ev.text_delta
                    yield AgentEvent("text", text=ev.text_delta)
                if ev.usage:
                    response.usage = ev.usage
                    yield AgentEvent("usage", text=f"{ev.usage.get('prompt', 0)}+{ev.usage.get('completion', 0)} tok")
                if ev.tool_calls is not None:
                    response.tool_calls = ev.tool_calls

            self.session.append(Message("assistant", response.text, tool_calls=response.tool_calls))
            if not response.tool_calls:
                self.session.save()
                yield AgentEvent("done")
                return

            for call in response.tool_calls:
                yield AgentEvent("tool_start", tool=call.name, args=call.arguments)
                result = self.tools.dispatch(call.name, call.arguments)
                self.session.append(Message(
                    "tool", result.output[:60_000],
                    tool_call_id=call.id, name=call.name))
                yield AgentEvent("tool_end", tool=call.name, result=result.output[:2000], ok=result.ok)

            self._maybe_compact()
            self.session.save()
        yield AgentEvent("error", text=f"stopped after {self.max_steps} steps (max_steps)")

    async def _stream_once(self) -> AsyncIterator[StreamEvent | AgentEvent]:
        try:
            async for ev in self.client.stream_chat(
                self._messages(), self.tools.specs(),
                model=model_id(self.session),
                max_tokens=self.max_tokens, temperature=self.temperature,
            ):
                yield ev
        except LLMError as exc:
            yield AgentEvent("error", text=str(exc))
        except Exception as exc:  # noqa: BLE001 — network/JSON errors surface to user
            yield AgentEvent("error", text=f"{type(exc).__name__}: {exc}")

    def _maybe_compact(self) -> None:
        total = sum(len(m.content) for m in self.session.messages)
        if total > COMPACT_TRIGGER_CHARS and len(self.session.messages) > 12:
            keep = max(8, len(self.session.messages) // 3)
            cut = len(self.session.messages) - keep
            # Never start the window on a tool result: its parent assistant
            # tool_calls would be dropped and the provider returns 400.
            msgs = self.session.messages
            while cut < len(msgs) and msgs[cut].role == "tool":
                cut += 1
            if cut < len(msgs):
                self.session.compacted_from = cut


def model_id(session: Session) -> str:
    """Session.model is 'provider/model'; clients want the bare model id."""
    return session.model.split("/", 1)[1] if "/" in session.model else session.model
