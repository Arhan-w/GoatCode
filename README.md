<div align="center">

# 🐐 GoatCode v2

**Every provider. One terminal. MCP + skills + plugins. Now in TypeScript.**

The Claude Code-style agentic coding CLI — rebuilt on Bun for a single
standalone binary. 183 providers, subscription OAuth (Claude Pro/Max,
ChatGPT, Gemini, Copilot, Kimi, Grok → working API credentials), streaming
markdown under a live spinner, sandboxed tools with permission prompts,
**MCP servers**, **SKILL.md skills**, and **plugins**.

![GoatCode live](docs/assets/demo.gif)

[Install](#install) · [Quick start](#quick-start) · [The TUI](#the-tui) ·
[Desktop control](#desktop-control) · [MCP](#mcp-servers) · [Skills](#skills) ·
[Providers](#providers) ·
[OAuth](#subscription-oauth)

</div>

---

## Why GoatCode over Claude Code / Codex / the rest

| | Claude Code | Codex CLI | **GoatCode** |
|---|---|---|---|
| Models | Anthropic only | OpenAI only | **any of 183 providers** + any OpenAI / Anthropic / Responses / Gemini-shaped endpoint, switch mid-session (`/model`) |
| Your subscriptions | Claude only | ChatGPT only | **Claude Pro/Max · ChatGPT · Gemini · Copilot · Kimi · Grok** → OAuth to real API credentials, no per-seat agent fee on top |
| Desktop control | separate paid harness | — | **built in** — `screenshot` + `computer` (click/type/launch/clipboard), background input |
| Install | Node runtime | Node runtime | **one file on PATH** (5 platforms, prebuilt) — one curl command |
| Cost blindness | guess | guess | `/cost` prices real token counts against a live rate table |
| Open source | no | yes-ish | **yes, MIT** — read the loop, patch the loop |
| Compatibility | — | — | drop-in: `.claude/skills`, `.mcp.json`, Claude `settings.json` hook & permission shapes all work |

Same agentic core you'd expect — streaming TUI, plan mode, permission
prompts, sub-agents, parallel tool calls, hooks, undo checkpoints — minus the
vendor lock-in and the second subscription. If you live in one model, the
big ones are great. If you'd rather pay whoever wins *this month*, that's
GoatCode.

## What's new in v2

| | v1 (Python) | v2 (TypeScript/Bun) |
|---|---|---|
| Runtime | Python 3.10+ | **single `goat.exe` / binary** — no interpreter needed |
| TUI | rich + prompt_toolkit | **Ink/React** — Claude Code-style: ❯ box, spinner verbs, ●/⎿ tools, numbered permission dialog |
| Modes | auto-approve toggle | **4-mode cycle** (shift+tab): ask · accept-edits · plan · bypass |
| Extensibility | — | **MCP servers** (stdio/http/sse) · **skills** (SKILL.md) · **plugins** |
| Desktop | — | **see the screen + drive real apps** — `screenshot`/`computer` tools, cua-driver or native (click, type, keys, launch, clipboard) |
| Context | — | **@file references** · **!bash mode** · **# memory** → GOAT.md |
| Resilience | one-shot failure | **retry w/ jittered backoff** on 429/5xx/network, `retry-after` honored, esc interrupts mid-request |
| Engine | 60 tests | same 4 wire formats, OAuth flows, sessions, compaction, **vision input** — **78 tests + full e2e** |

## Install

```bash
npm install -g goatcode     # any OS with node/npm — fetches the right binary
```

or, without npm (PowerShell / curl):

```powershell
# Windows (PowerShell)
powershell -c "irm https://raw.githubusercontent.com/Arhan-w/GoatCode/v2-typescript/install.ps1 | iex"
```

```bash
# Linux / macOS / Git-Bash (curl)
curl -fsSL https://raw.githubusercontent.com/Arhan-w/GoatCode/v2-typescript/install.sh | bash
```

The installer grabs the prebuilt release binary for your platform, verifies
it, and puts it on PATH. Re-run it any time to upgrade. No runtime, no
interpreter — one file.

<details>
<summary>Build from source instead</summary>

```bash
# with Bun (1.1+): run from source
git clone https://github.com/Arhan-w/GoatCode && cd GoatCode
bun install

# or build the standalone binary (~100 MB, zero dependencies)
bun build src/index.ts --compile --outfile goat
```

</details>

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
- **Ctrl+V** pastes a clipboard *image* straight into your message (screenshots,
  designs — any vision model sees it); text pastes work as normal input
- **websearch** — the model looks things up live (DuckDuckGo, no API key) and
  **webfetch**es the best result for details
- **small_model** — route background work (compaction, explore sub-agents) to a
  cheap model while the main turn stays on the frontier one

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

**Parallel tool calls** — when the model asks for five `read`s, they fan out
concurrently and land back in transcript order. Exploring a codebase costs one
round of latency, not five.

## Desktop control

GoatCode doesn't just edit files — it can **see your screen and drive real
apps**. Two tools, one agent loop:

- `screenshot` — captures the desktop and *attaches the pixels to the model's
  next turn*. Vision models literally see what you see.
- `computer` — `click` / `double_click` / `right_click` / `type` / `key` /
  `scroll` / `launch` / `windows` / `clipboard`, with coordinates read straight
  off the screenshot.

Backends auto-detect, best available wins:

| Backend | Delivery | Install |
|---|---|---|
| **cua-driver** (preferred) | background — clicks/types route to the target window via UIA/PostMessage; your cursor and focus never move | `cua-driver` one-time install |
| PowerShell + Win32 | native SendInput/GDI, foreground | none — Windows ships with it |
| osascript / screencapture | AppleScript + cliclick | macOS stock (cliclick for clicks) |
| xdotool / xclip | X11 input + clip | Linux stock |

```console
❯ open notepad and write a haiku about goats
● computer  launch notepad
  ⎿ completed  [cua-driver] launched notepad (pid 9452)
● screenshot
  ⎿ completed  screen captured (1366x768)
● computer  type · window_title "Untitled - Notepad"
  ⎿ completed  [cua-driver] typed 42 chars
```

Permission-gated by the same rules as everything else (`Computer(...)` allow/
deny rules apply), blocked outright in plan mode, never handed to read-only
sub-agents, and a hard never-send list refuses `Win+L`, `Ctrl+Alt+Del` and
friends no matter what the model requests.

## Hooks, rules, styles — Claude-compatible config

Drop-in compatible with Claude Code's `settings.json` shapes, in
`~/.goatcode/config.json` or `goatcode.json`:

```json
{
  "permissions": {
    "allow": ["Bash(git add:*)", "Edit(src/**)", "WebFetch(domain:docs.rs)"],
    "deny":  ["Bash(git push*)", "Read(~/.ssh/**)", "Computer(type)"]
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

- **Permission prompts** — write/edit/bash/computer show the exact target;
  plan mode blocks mutations and desktop input at the dispatcher; bypass is
  explicit and labeled in the status bar.
- **Desktop guardrails** — every `computer`/`screenshot` call is permission-
  gated and rule-gated (`Computer(...)`); a never-send list hard-refuses
  `Win+L` / `Ctrl+Alt+Del` / force-quit combos; sub-agents never get the
  desktop at all.
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
| Tests | 78 bun tests + live e2e under a real ConPTY (providers, MCP, skills, plugins, agent loop, undo, retry, timeout, plan panel, vision, desktop control, websearch, parallel tools, small-model routing) |
| Type check | `tsc --noEmit` clean, strict |

## Development

```bash
bun install
bun test                    # 78 tests, ~6s, no network
bunx tsc --noEmit           # strict type check
bun run src/index.ts        # dev TUI
bun build src/index.ts --compile --outfile dist/goat   # ship it
```

### Releasing

Bump the version in `package.json`, `src/index.ts` (`--version`),
`src/statusline.ts`, and `npm-package/package.json` (must match the tag —
the npm wrapper resolves its binary from `v<version>`), update
[CHANGELOG.md](CHANGELOG.md), then:

```bash
git commit -am "vX.Y.Z — <summary>" && git tag vX.Y.Z && git push origin HEAD:v2-typescript vX.Y.Z
```

CI cross-compiles 5 platforms and publishes the GitHub release;
`npm publish ./npm-package` ships the wrapper.

## License

MIT — see [LICENSE](LICENSE) and the full [CHANGELOG](CHANGELOG.md).
