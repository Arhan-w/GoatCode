<div align="center">

# 🐐 GoatCode v2

**Every provider. One terminal. MCP + skills + plugins. Now in TypeScript.**

The Claude Code-style agentic coding CLI — rebuilt on Bun for a single
standalone binary. 183 providers, subscription OAuth (Claude Pro/Max,
ChatGPT, Gemini, Copilot, Kimi, Grok → working API credentials), streaming
markdown under a live spinner, sandboxed tools with permission prompts,
**MCP servers**, **SKILL.md skills**, and **plugins**.

[Install](#install) · [Quick start](#quick-start) · [The TUI](#the-tui) ·
[MCP](#mcp-servers) · [Skills](#skills) · [Providers](#providers) ·
[OAuth](#subscription-oauth)

</div>

---

## What's new in v2

| | v1 (Python) | v2 (TypeScript/Bun) |
|---|---|---|
| Runtime | Python 3.10+ | **single `goat.exe` / binary** — no interpreter needed |
| TUI | rich + prompt_toolkit | **Ink/React** — Claude Code-style: ❯ box, spinner verbs, ●/⎿ tools, numbered permission dialog |
| Modes | auto-approve toggle | **4-mode cycle** (shift+tab): ask · accept-edits · plan · bypass |
| Extensibility | — | **MCP servers** (stdio/http/sse) · **skills** (SKILL.md) · **plugins** |
| Context | — | **@file references** · **!bash mode** · **# memory** → GOAT.md |
| Resilience | one-shot failure | **retry w/ jittered backoff** on 429/5xx/network, `retry-after` honored, esc interrupts mid-request |
| Engine | 60 tests | same 4 wire formats, OAuth flows, sessions, compaction — **40 TS tests + full e2e** |

## Install

```bash
# with Bun (1.1+): run from source
git clone https://github.com/Arhan-w/GoatCode && cd GoatCode
bun install

# or build the standalone binary (~100 MB, zero dependencies)
bun build src/index.ts --compile --outfile goat

# or grab the latest release and put it on your PATH — one file, nothing else
# windows:   copy goat.exe D:\bin   ·   PATH += D:\bin
```

Prebuilt binaries: see [Releases](../../releases).

## Quick start

```console
$ goat auth anthropic --key sk-ant-...
stored API key for anthropic

$ goat
 ██████╗  ██████╗  █████╗ ████████╗
██╔════╝ ██╔═══██╗██╔══██╗╚══██╔══╝
██║      ██║   ██║███████║   ██║
██║      ██║   ██║██╔══██║   ██║
╚██████╗ ╚██████╔╝██║  ██║   ██║
 ╚═════╝  ╚═════╝ ╚═╝  ╚═╝   ╚═╝
GoatCode  v2.0  ·  every provider, one terminal

❯ fix the typo in @src/util.ts
● read src/util.ts
  ⎿ completed  export const formater = …
● edit src/util.ts
  ⎿ completed  edited src/util.ts
Renamed `formater` → `formatter` in src/util.ts:12.

  ask before edits  (shift+tab to cycle)  ·  anthropic/claude-sonnet-4-5  ·  ~/code/myapp  ·  /help
```

One-shot for scripts and CI:

```bash
goat -p "summarize what @setup.py does" -q
goat --auto -m freellmapi/auto -p "run the tests and fix failures"
goat -c    # resume the most recent session
```

## The TUI

Claude Code's interaction model, GoatCode's engine:

- **❯ prompt box** with rounded border, placeholder, ↑↓ history
- **live spinner** — random verb (`Reticulating… 4s · 212 tok  esc to interrupt`)
  over streaming markdown
- **● tool / ⎿ result** lines, colored by outcome
- **numbered permission dialog** — Yes · Yes-all-session · No (esc cancels)
- **shift+tab / ctrl+o mode cycle** — `ask before edits → ⏵⏵ accept edits → ⏸ plan → ⏩ bypass`
- **/** completion menu with descriptions for every command
- **@file** injects file contents · **!cmd** runs bash inline · **# note** saves to GOAT.md

| Key / command | What |
|---|---|
| `Enter` | send · `Ctrl+C` cancel/exit · `Esc` interrupt |
| `Shift+Tab` / `Ctrl+O` | cycle permission mode |
| `Ctrl+T` | background task list |
| `/model <p/id>` · `/models` · `/providers` | switch and browse |
| `/auth <p> --key K` · `--oauth` | credentials in-chat |
| `/mcp` · `/skills` · `/plugin` | extensions status |
| `/new` `/clear` `/compact` `/sessions` `/resume <id>` | sessions |
| `/undo` | revert the last turn's file changes (snapshot per mutation) |
| `/tasks` | background bash jobs started with `bash background:true` |
| `/cost` `/context` `/doctor` `/init` `/review` | diagnostics |

**`/compact` is real** — it folds older messages into a deterministic digest
and keeps the tail, so long sessions stay inside the window without an
extra API call.

**Plan mode is enforced, not decorative** — in `⏸ plan`, every mutating tool
(write/edit/bash) is denied at dispatch with instructions to leave the mode.

**Checkpoints** — each write/edit captures the before/after content, so
`/undo` rewinds the whole last turn, including files the agent created
(those get deleted). **Background tasks** — the agent can start long jobs
and keep working; finished jobs are announced between turns.

**It survives flaky APIs** — a 429, 5xx, or dropped connection before any
tokens stream is retried with capped exponential backoff + jitter (honoring
the server's `retry-after`), shown inline as `↻ retrying`. A provider that
merely *hangs* gets cut off after 120 s per attempt and retried too
(`GOAT_REQUEST_TIMEOUT` to change it). Once output has streamed, GoatCode
stops instead of retrying — no duplicated answers. Esc interrupts even
mid-backoff.

**Knows what you spent** — `/cost` prices the session's real token counts
against a per-family rate table (Claude, GPT, Gemini, DeepSeek, Llama,
Mistral, Qwen…), so you see `≈ $0.42 this session (live)` instead of a
shrug.

## MCP servers

Model Context Protocol — plug in any MCP server, tools appear as
`mcp__<server>__<tool>`:

```bash
goat mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
goat mcp add --transport http sentry https://mcp.sentry.dev/mcp
goat mcp list
```

Or drop a Claude-compatible **`.mcp.json`** in your project:

```json
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }
```

## Skills

Claude-compatible **SKILL.md** folders with progressive disclosure — only
name/description/when-to-use enter the system prompt; the body loads when
invoked:

```
skills/commit/SKILL.md          →  /commit
.claude/skills/review/SKILL.md  →  /review   (existing Claude skills work)
```

```markdown
---
name: commit
description: Create a well-formatted git commit
when_to_use: When the user asks to commit changes
---
1. Run git status and git diff
2. Write a conventional-commit message
3. Commit. Never push unless asked.
```

User-level skills live in `~/.goatcode/skills/`. `/skills` lists everything.

## Plugins

A plugin dir contributes `/commands/<name>.md` (frontmatter description +
`$ARGUMENTS` body → an invokable prompt) and `/skills/<name>/SKILL.md`,
loaded via config:

```json
{ "plugins": ["~/my-plugins/reviewer"] }
```

Plugin commands and skills land in the same `/palette` as native ones —
`/changelog fix urgent bugs` just works. `/plugin` lists what loaded.

## Providers

183 built in — OpenAI, Anthropic, DeepSeek, Groq, OpenRouter, Ollama, and
177 more — across four wire formats (`openai`, `claude`, `openai-responses`,
`gemini`), plus any custom endpoint:

```bash
goat providers                    # ✓ marks configured ones
goat endpoint add ollama --base-url http://localhost:11434/v1 --models llama3.2
```

## Subscription OAuth

```bash
goat auth claude --oauth          # browser PKCE + CSRF state
goat auth github-copilot --oauth  # device code → Copilot API token
goat auth --list-oauth            # claude · codex · gemini · github-copilot · kimi · grok
```

Tokens live in `~/.goatcode/credentials.json` and auto-refresh before expiry.

## Safety model

- **Permission prompts** — write/edit/bash show the exact target; plan mode
  blocks mutations at the dispatcher; bypass is explicit and labeled in the
  status bar.
- **Path sandbox** — file tools and @refs reject anything outside the project
  root (membership check, not string prefix).
- **Undo checkpoints** — every write/edit snapshots before/after; `/undo`
  rewinds the last turn, deleting files the agent created.
- **Bounded output** — 128 KB per read, 32 KB per bash call, 500 KB per snapshot.
- **Config hygiene** — `goat mcp add` never leaks a project's `.mcp.json`
  servers into your user config, and hand-edited keys survive every save.

## Performance

| Metric | Value |
|---|---|
| Cold start (`goat --version`) | **~0.6 s** (binary) |
| Binary | single file, no runtime install |
| Tests | 40 bun tests + live e2e (providers, MCP, skills, plugins, agent loop, undo, retry, timeout) |
| Type check | `tsc --noEmit` clean, strict |

## Development

```bash
bun install
bun test                    # 40 tests, ~6s, no network
bunx tsc --noEmit           # strict type check
bun run src/index.ts        # dev TUI
bun build src/index.ts --compile --outfile dist/goat   # ship it
```

## License

MIT
