"""Session persistence: JSONL transcripts under ~/.goatcode/sessions/.

JSONL over SQLite keeps the dependency count at zero and memory tiny —
we only ever load the tail window we need.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .config import app_dir
from .llm import Message, ToolCall


def sessions_dir() -> Path:
    d = app_dir() / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Session:
    id: str
    cwd: str
    model: str
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    title: str = ""
    messages: list[Message] = field(default_factory=list)
    compacted_from: int = 0  # messages before this index are summarized away

    @property
    def path(self) -> Path:
        return sessions_dir() / f"{self.id}.jsonl"

    @classmethod
    def new(cls, cwd: str, model: str) -> "Session":
        return cls(id=uuid.uuid4().hex[:12], cwd=cwd, model=model)

    def save(self) -> None:
        header = {"type": "meta", "id": self.id, "cwd": self.cwd, "model": self.model,
                  "created": self.created, "updated": time.time(), "title": self.title,
                  "compacted_from": self.compacted_from}
        lines = [json.dumps(header)]
        for m in self.messages:
            entry = {"type": "message", **asdict(m)}
            lines.append(json.dumps(entry))
        self.path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, sid: str) -> "Session":
        path = sessions_dir() / f"{sid}.jsonl"
        if not path.exists():
            raise FileNotFoundError(f"no session {sid}")
        return cls._parse(path.read_text(encoding="utf-8"))

    @classmethod
    def _parse(cls, text: str) -> "Session":
        meta: dict[str, Any] = {}
        messages: list[Message] = []
        for line in text.splitlines():
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "meta":
                meta = data
            elif data.get("type") == "message":
                calls = [ToolCall(**tc) for tc in data.get("tool_calls") or []]
                messages.append(Message(role=data.get("role", "user"),
                                        content=data.get("content") or "",
                                        tool_calls=calls,
                                        tool_call_id=data.get("tool_call_id"),
                                        name=data.get("name")))
        return cls(id=meta.get("id", "?"), cwd=meta.get("cwd", ""), model=meta.get("model", ""),
                   created=meta.get("created", 0), updated=meta.get("updated", 0),
                   title=meta.get("title", ""), messages=messages,
                   compacted_from=meta.get("compacted_from", 0))

    def context(self) -> list[Message]:
        """Messages to send to the model (skips compacted prefix)."""
        return self.messages[self.compacted_from:]

    def append(self, msg: Message) -> None:
        self.messages.append(msg)
        self.updated = time.time()


def list_sessions(limit: int = 20) -> list[dict[str, Any]]:
    rows = []
    for path in sorted(sessions_dir().glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        try:
            with path.open(encoding="utf-8") as fh:
                meta = json.loads(fh.readline())
            if meta.get("type") == "meta":
                meta["id"] = path.stem
                rows.append(meta)
        except (json.JSONDecodeError, IndexError):
            continue
    return rows


def summarize(messages: list[Message], max_chars: int = 4000) -> str:
    """Cheap deterministic compaction: last-N user/assistant text digest.

    No extra LLM call — keeps GoatCode usable on slow connections and free
    tiers. The digest is injected as a system message.
    """
    parts: list[str] = []
    total = 0
    for m in reversed(messages):
        if m.role not in ("user", "assistant") or not m.content:
            continue
        snippet = m.content.strip().replace("\n", " ")[:280]
        line = f"[{m.role}] {snippet}"
        total += len(line)
        if total > max_chars:
            break
        parts.append(line)
    return "Earlier conversation summary (oldest last):\n" + "\n".join(reversed(parts))
