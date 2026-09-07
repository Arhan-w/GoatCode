"""Tool sandboxing, permissions, and behavior."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from goatcode.tools import ToolKit


@pytest.fixture
def root(tmp_path):
    (tmp_path / "hello.txt").write_text("line one\nline two\nline three\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("def goat():\n    return 42\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "skip.py").write_text("x = 1\n", encoding="utf-8")
    return tmp_path


def kit(root, **kw):
    return ToolKit(root, auto_approve=True, **kw)


def test_read_with_line_numbers(root):
    res = kit(root).tool_read({"path": "hello.txt"})
    assert res.ok and "1\tline one" in res.output


def test_read_offset_limit(root):
    res = kit(root).tool_read({"path": "hello.txt", "offset": 2, "limit": 1})
    assert "line two" in res.output and "line one" not in res.output


def test_path_escape_blocked(root):
    tk = kit(root)
    res = tk.dispatch("read", {"path": "../outside.txt"})
    assert not res.ok and "escapes" in res.output


def test_prefix_sibling_directory_blocked(root, tmp_path):
    """'/root' is a string prefix of '/rootsecret' — membership must not be prefix-based."""
    sibling = Path(str(root) + "secret")
    sibling.mkdir()
    (sibling / "keys.txt").write_text("TOP_SECRET", encoding="utf-8")
    tk = kit(root)
    rel = os.path.relpath(sibling / "keys.txt", root)
    res = tk.dispatch("read", {"path": rel})
    assert not res.ok and "escapes" in res.output
    # sanity: the file exists and is readable — only the sandbox stops us
    assert (sibling / "keys.txt").read_text() == "TOP_SECRET"


def test_write_and_edit(root):
    tk = kit(root)
    assert tk.tool_write({"path": "new/f.txt", "content": "hi"}).ok
    assert (root / "new" / "f.txt").read_text() == "hi"
    res = tk.tool_edit({"path": "hello.txt", "old_string": "line two", "new_string": "LINE 2"})
    assert res.ok and "LINE 2" in (root / "hello.txt").read_text()


def test_edit_requires_unique_match(root):
    (root / "dup.txt").write_text("x\nx\n", encoding="utf-8")
    res = kit(root).tool_edit({"path": "dup.txt", "old_string": "x", "new_string": "y"})
    assert not res.ok and "2 times" in res.output


def test_edit_missing_string(root):
    res = kit(root).tool_edit({"path": "hello.txt", "old_string": "nope", "new_string": "y"})
    assert not res.ok and "not found" in res.output


def test_bash_runs_in_root(root):
    cmd = "cd" if sys.platform == "win32" else "pwd"
    res = kit(root).tool_bash({"command": cmd})
    out = res.output.lower().replace("/", "\\")
    assert res.ok and str(root.resolve()).lower().replace("/", "\\") in out


def test_bash_timeout(root):
    res = kit(root).tool_bash(
        {"command": f'"{sys.executable}" -c "import time; time.sleep(5)"', "timeout": 1})
    assert not res.ok and "timed out" in res.output


def test_bash_nonzero_exit_flagged(root):
    res = kit(root).tool_bash({"command": "exit 3" if sys.platform != "win32" else "exit /b 3"})
    assert not res.ok and "exit code 3" in res.output


def test_glob_skips_noise_dirs(root):
    res = kit(root).tool_glob({"pattern": "**/*.py"})
    assert "src/main.py" in res.output and "node_modules" not in res.output


def test_grep_finds_and_respects_glob(root):
    res = kit(root).tool_grep({"pattern": "def (\\w+)", "glob": "*.py"})
    assert "src/main.py:1:" in res.output and "goat" in res.output


def test_grep_invalid_regex(root):
    res = kit(root).tool_grep({"pattern": "([unclosed"})
    assert not res.ok and "invalid regex" in res.output


def test_permission_denied_blocks_write(root):
    tk = ToolKit(root, auto_approve=False, permission=lambda t, a: False)
    res = tk.dispatch("write", {"path": "blocked.txt", "content": "x"})
    assert not res.ok and "denied" in res.output
    assert not (root / "blocked.txt").exists()


def test_permission_prompt_receives_tool_name(root):
    seen = []
    def perm(tool, args):
        seen.append(tool)
        return True
    tk = ToolKit(root, auto_approve=False, permission=perm)
    tk.dispatch("bash", {"command": "echo hi"})
    assert seen == ["bash"]


def test_unknown_tool(root):
    res = kit(root).dispatch("teleport", {})
    assert not res.ok and "unknown tool" in res.output
