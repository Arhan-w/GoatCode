"""Agent tools: read, write, edit, bash, glob, grep.

All paths are sandboxed to the project root. Destructive operations (write,
edit, bash) route through a permission callback unless auto-approve is on.
"""
from __future__ import annotations

import fnmatch
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .llm import ToolSpec

MAX_READ_BYTES = 128_000      # ~32k tokens; keeps 4 GB boxes and small contexts safe
MAX_BASH_OUTPUT = 32_000
BASH_TIMEOUT = 120
GREP_MAX_RESULTS = 200
GLOB_MAX_RESULTS = 300
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist",
             "build", ".next", ".cache", "target", ".tox", ".mypy_cache"}


@dataclass
class ToolResult:
    ok: bool
    output: str


PermissionFn = Callable[[str, dict[str, Any]], bool]  # (tool, args) -> approved?


class ToolKit:
    def __init__(self, root: Path, *, permission: PermissionFn | None = None,
                 auto_approve: bool = False) -> None:
        self.root = root.resolve()
        self.permission = permission
        self.auto_approve = auto_approve

    # ---- safety helpers -------------------------------------------------

    def _inside(self, path: str) -> Path:
        p = (self.root / path) if not Path(path).is_absolute() else Path(path)
        p = p.resolve()
        # Membership, not string-prefix: "/root" is a prefix of "/rootkit" but
        # is not its parent — a startswith check leaks sibling directories.
        if p != self.root and self.root not in p.parents:
            raise ValueError(f"path escapes project root: {path}")
        return p

    def _ask(self, tool: str, args: dict[str, Any]) -> ToolResult | None:
        if self.auto_approve:
            return None
        if self.permission is None:
            return ToolResult(False, f"permission required but no prompt available for {tool}")
        if not self.permission(tool, args):
            return ToolResult(False, f"user denied {tool} for {args.get('path') or args.get('command', '')}")
        return None

    # ---- specs ----------------------------------------------------------

    def specs(self) -> list[ToolSpec]:
        return [
            ToolSpec("read", "Read a file from the project. Returns text with line numbers.", {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path relative to project root"},
                    "offset": {"type": "integer", "description": "1-based start line (optional)"},
                    "limit": {"type": "integer", "description": "Max lines to read (optional)"},
                },
                "required": ["path"],
            }),
            ToolSpec("write", "Create or overwrite a file with exact content.", {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string", "description": "Full file content"},
                },
                "required": ["path", "content"],
            }),
            ToolSpec("edit", "Replace one exact string in a file (must match once).", {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string", "description": "Exact text to replace, unique in file"},
                    "new_string": {"type": "string"},
                },
                "required": ["path", "old_string", "new_string"],
            }),
            ToolSpec("bash", "Run a shell command in the project directory.", {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "integer", "description": f"Seconds, default {BASH_TIMEOUT}"},
                },
                "required": ["command"],
            }),
            ToolSpec("glob", "Find files by pattern, e.g. 'src/**/*.ts'.", {
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            }),
            ToolSpec("grep", "Search file contents by regex. Returns path:line:text.", {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex"},
                    "path": {"type": "string", "description": "Subdirectory to search (default .)"},
                    "glob": {"type": "string", "description": "Filename filter, e.g. '*.py'"},
                },
                "required": ["pattern"],
            }),
        ]

    def dispatch(self, name: str, args: dict[str, Any]) -> ToolResult:
        handler = getattr(self, f"tool_{name}", None)
        if handler is None:
            return ToolResult(False, f"unknown tool: {name}")
        try:
            return handler(args)
        except ValueError as exc:
            return ToolResult(False, str(exc))
        except Exception as exc:  # noqa: BLE001 — tool errors go back to the model
            return ToolResult(False, f"{type(exc).__name__}: {exc}")

    # ---- implementations --------------------------------------------------

    def tool_read(self, args: dict[str, Any]) -> ToolResult:
        p = self._inside(args["path"])
        if not p.is_file():
            return ToolResult(False, f"not a file: {args['path']}")
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return ToolResult(False, f"{args['path']} is not UTF-8 text")
        lines = text.splitlines()
        offset = max(1, int(args.get("offset") or 1))
        limit = int(args.get("limit") or 2000)
        chunk = lines[offset - 1: offset - 1 + limit]
        out = "\n".join(f"{offset + i:5d}\t{ln}" for i, ln in enumerate(chunk))
        remaining = max(0, len(lines) - (offset - 1) - len(chunk))
        if remaining or len(text.encode()) > MAX_READ_BYTES:
            out += f"\n... [{remaining} more lines]"
        return ToolResult(True, out or "(empty file)")

    def tool_write(self, args: dict[str, Any]) -> ToolResult:
        denied = self._ask("write", args)
        if denied:
            return denied
        p = self._inside(args["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        existed = p.exists()
        p.write_text(args["content"], encoding="utf-8")
        n = args["content"].count("\n") + 1
        return ToolResult(True, f"{'updated' if existed else 'created'} {args['path']} ({n} lines)")

    def tool_edit(self, args: dict[str, Any]) -> ToolResult:
        denied = self._ask("edit", args)
        if denied:
            return denied
        p = self._inside(args["path"])
        if not p.is_file():
            return ToolResult(False, f"not a file: {args['path']}")
        text = p.read_text(encoding="utf-8")
        old, new = args["old_string"], args["new_string"]
        count = text.count(old)
        if count == 0:
            return ToolResult(False, "old_string not found in file")
        if count > 1:
            return ToolResult(False, f"old_string matches {count} times; make it unique")
        p.write_text(text.replace(old, new, 1), encoding="utf-8")
        return ToolResult(True, f"edited {args['path']}")

    def tool_bash(self, args: dict[str, Any]) -> ToolResult:
        denied = self._ask("bash", args)
        if denied:
            return denied
        cmd = args["command"]
        timeout = min(int(args.get("timeout") or BASH_TIMEOUT), 600)
        shell = os.environ.get("COMSPEC") if sys.platform == "win32" else "/bin/bash"
        try:
            proc = subprocess.run(
                cmd, shell=True, executable=shell, cwd=self.root,
                capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace",
            )
        except subprocess.TimeoutExpired:
            return ToolResult(False, f"command timed out after {timeout}s")
        out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        out = out[:MAX_BASH_OUTPUT]
        tail = "" if proc.returncode == 0 else f"\n[exit code {proc.returncode}]"
        return ToolResult(proc.returncode == 0, (out.strip() or "(no output)") + tail)

    def tool_glob(self, args: dict[str, Any]) -> ToolResult:
        pattern = args["pattern"]
        matches: list[str] = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            rel_dir = os.path.relpath(dirpath, self.root).replace("\\", "/")
            for fn in filenames:
                rel = f"{rel_dir}/{fn}" if rel_dir != "." else fn
                if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(fn, pattern):
                    matches.append(rel)
                    if len(matches) >= GLOB_MAX_RESULTS:
                        return ToolResult(True, "\n".join(matches) + "\n... (truncated)")
        return ToolResult(True, "\n".join(sorted(matches)) or "(no matches)")

    def tool_grep(self, args: dict[str, Any]) -> ToolResult:
        try:
            rx = re.compile(args["pattern"])
        except re.error as exc:
            return ToolResult(False, f"invalid regex: {exc}")
        base = self._inside(args.get("path") or ".")
        glob = args.get("glob")
        results: list[str] = []
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                if glob and not fnmatch.fnmatch(fn, glob):
                    continue
                fp = Path(dirpath) / fn
                try:
                    if fp.stat().st_size > 2_000_000:
                        continue
                    with fp.open(encoding="utf-8", errors="strict") as fh:
                        for lineno, line in enumerate(fh, 1):
                            if rx.search(line):
                                rel = fp.resolve().relative_to(self.root)
                                rel = str(rel).replace("\\", "/")
                                results.append(f"{rel}:{lineno}:{line.rstrip()[:200]}")
                                if len(results) >= GREP_MAX_RESULTS:
                                    return ToolResult(True, "\n".join(results) + "\n... (truncated)")
                except (UnicodeDecodeError, OSError):
                    continue
        return ToolResult(True, "\n".join(results) or "(no matches)")
