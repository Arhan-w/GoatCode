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
| Engine | 60 tests | same 4 wire formats, OAuth flows, sessions, compaction, **vision input** — **54 TS tests + full e2e** |

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
██║  ███╗██║   ██║███████║   ██║
██║   ██║██║   ██║██╔══██║   ██║
╚██████╔╝╚██████╔╝██║  ██║   ██║
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
goat --auto -m provider/model -p "run the tests and fix failures"
goat -c    # resume the most recent session
```

## The TUI

Claude Code's interaction model, GoatCode's engine:

- **❯ prompt box** with rounded border, placeholder, ↑↓ history
- **live plan panel** — the agent's todo list pinned under the prompt:
  `▸ Running tests` while in progress, `○` pending, `✔` struck through
  (same content/activeForm schema as Claude Code's TodoWrite)
- **sub-agents** — the `task` tool spawns a fresh-context worker that shares
  your tools, permissions and undo stack; `explore` type is read-only. No
  recursion, no context bleed.
- **live spinner** — random verb (`Reticulating… 4s · 212 tok  esc to interrupt`)
  over streaming markdown
- **● tool / ⎿ result** lines, colored by outcome
- **numbered permission dialog** — Yes · Yes-all-session · No (esc cancels)
- **shift+tab / ctrl+o mode cycle** — `ask before edits → ⏵⏵ accept edits → ⏸ plan → ⏩ bypass`
- **/** completion menu with descriptions for every command
- **@file** injects file contents · **!cmd** runs bash inline · **# note** saves to GOAT.md

| Key / command | What |
|---|---|
| `Enter` | send · `Ctrl+C` cancel/exit (×2) · `Esc` interrupt |
| `Shift+Tab` / `Ctrl+O` | cycle permission mode |
| `Ctrl+T` / `Ctrl+K` / `Ctrl+L` / `Ctrl+R` | tasks · clear input · clear screen · search history |
| `/model <p/id>` · `/models` · `/providers` | switch and browse |
| `/auth <p> --key K` · `--oauth` | credentials in-chat |
| `/mcp` · `/skills` · `/plugin` | extensions status |
| `/new` `/clear` `/compact` `/sessions` `/resume <id>` | sessions |
| `/undo` | revert the last turn's file changes (snapshot per mutation) |
| `/tasks` | background bash jobs started with `bash background:true` |
| `/cost` `/usage` `/context` `/status` `/doctor` | diagnostics |
| `/rename <t>` `/memory` `/init` `/review` | session & project |

**@file works with images too** — `what's wrong in @screenshot.png?` attaches
the actual pixels to your message on Claude, GPT-4o-class, Responses, and
Gemini models. The `read` tool shows images to the model as well.

**`/compact` is real** — it asks the model for a dense continuation
summary of your old context (goals, decisions, files touched, open
threads), stores it in the session, and keeps the tail. If the model call
fails it falls back to the free deterministic digest — compaction never
blocks. `Ctrl+C` twice to exit; one press warns first.

**Plan mode is enforced, not decorative** — in `⏸ plan`, every mutating tool
(write/edit/bash) is denied at dispatch with instructions to leave the mode.

## Hooks, rules, styles — Claude-compatible config

Drop-in compatible with Claude Code's `settings.json` shapes, in
`~/.goatcode/config.json` or `goatcode.json`:

```json
{
  "permissions": {
    "allow": ["Bash(git add:*)", "Edit(src/**)", "WebFetch(domain:docs.rs)"],
    "deny":  ["Bash(git push*)", "Read(~/.ssh/**)"]
  },
  "hooks": {
    "PreToolUse":  [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "my-guard" }] }],
    "PostToolUse": [{ "hooks": [{ "command": "formatter --fix $file" }] }],
    "Stop":        [{ "hooks": [{ "command": "check-tests-pass" }] }]
  },
  "status_line": { "command": "my-statusline.sh" },
  "output_style": "Explanatory",
  "small_model": "groq/llama-3.3-70b"
}
```

- **Permission rules** — deny > allow > prompt; `:*` prefixes, globs,
  `domain:` for webfetch; compound commands can't sneak past prefix-allow
  (same anti-bypass rule Claude uses).
- **Hooks** — JSON on stdin, exit 2 blocks with stderr as the reason,
  `permissionDecision`/`updatedInput` on stdout; a blocking Stop hook feeds
  its reason back to the model as "keep going" feedback (capped at 4).
- **Statusline** — your command receives the session JSON on stdin; its
  output lines replace the footer.
- **Output styles** — `~/.goatcode/output-styles/<name>.md` changes how the
  agent talks; built-in `Explanatory` teaches as it works.
- **WebFetch tool** — the model can read docs URLs itself (SSRF-guarded:
  loopback/private/metadata hosts refused).
- **@dir** — `@src/` injects a one-level file listing; `@file#L10-20` style
  refs and images work too.

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
| Tests | 54 bun tests + live e2e under a real ConPTY (providers, MCP, skills, plugins, agent loop, undo, retry, timeout, plan panel, vision) |
| Type check | `tsc --noEmit` clean, strict |

## Development

```bash
bun install
bun test                    # 54 tests, ~6s, no network
bunx tsc --noEmit           # strict type check
bun run src/index.ts        # dev TUI
bun build src/index.ts --compile --outfile dist/goat   # ship it
```

## License

MIT
