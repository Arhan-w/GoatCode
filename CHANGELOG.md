# Changelog

All notable changes to GoatCode. Versions match git tags and npm releases.

## [2.1.3] - 2026-09-10
### Added
- **Interactive `goat auth`** — running `goat auth` with no arguments now
  walks you through provider → method (OAuth / paste key) instead of printing
  a usage line. First-run friction is the #1 adoption killer.
- `npm install -g goatcode-cli` — the npm wrapper ships in `npm-package/`:
  postinstall downloads the platform binary from GitHub releases (with an
  exact-version URL first, `latest` as fallback), and the launcher self-heals
  if scripts were skipped.
- CHANGELOG.md, GitHub social preview card, release-procedure docs.

## [2.1.2] - 2026-09-10
### Added
- First-run auth banner — a credential-less install now says exactly what to
  do (`goat auth <provider> --key …` / `--oauth`) instead of booting into a
  silent shell; the banner clears itself after `/auth` or a successful turn.
- `/auth --list` — enumerate OAuth providers in-chat.

### Fixed
- `/auth <provider> --key <K>` stored a corrupted placeholder instead of the
  key (introduced in 2.1.1 development).

## [2.1.1] - 2026-09-09
### Added
- **Ctrl+V image paste** in the TUI — screenshots/designs from the clipboard
  attach straight to your message (Windows/macOS/Linux, magic-byte verified,
  size-capped).
- Release matrix now builds 5 platforms per tag: windows-x64, linux-x64,
  linux-arm64, darwin-arm64, darwin-x64 (bun cross-compiles the last three).

### Fixed
- **Shift+Tab mode cycle** — the handler never matched Ink's
  shift+tab key event; pressing it did nothing on every terminal. Verified
  with a real-pty e2e (ask → accept-edits → plan → bypass → ask).
- Hung-request timeout test widened (30 ms deadline flaked under CI load).

## [2.1.0] - 2026-09-09
### Added
- **Desktop control** — `screenshot` (attaches live pixels to vision models)
  and `computer` (click / double_click / right_click / type / key / scroll /
  launch / windows / clipboard). Backends auto-detect: cua-driver (background
  input, no focus steal) → PowerShell SendInput → AppleScript → xdotool.
  Guardrails: permission + `Computer(...)` rules, plan-mode block, no
  desktop for sub-agents, never-send list (Win+L, Ctrl+Alt+Del, force-quit).
- **websearch** — keyless DuckDuckGo search for the model.
- **Parallel tool calls** — read/glob/grep batches fan out concurrently and
  return in transcript order.
- **small_model routing** — compaction and explore sub-agents run on a cheap
  model (`"small_model"` in config).
- One-command installers: `install.sh` (curl) and `install.ps1` (irm), with
  prebuilt-binary-first strategy, source-build fallback, PATH wiring.
- Repo metadata for npm publishing; `/undo` message fixes.

## [2.0.x] - 2026-09-08/09 (development)
- TypeScript/Bun rewrite: Ink/React TUI (streaming markdown, spinner, ●/⎿
  tool lines, numbered permission dialog), 4-mode cycle, subagents (task),
  Claude-compatible hooks + permission rules, MCP (stdio/http/sse), SKILL.md
  skills, plugins, GOAT.md memory, vision input across all 4 wire formats,
  @file/@dir refs, !bash, # memory, /compact (model-summarized), /cost,
  /export, /doctor, undo checkpoints, background bash, retry w/ backoff +
  request timeouts, JSONL sessions, 183-provider catalog + subscription
  OAuth (Claude · ChatGPT · Gemini · Copilot · Kimi · Grok), custom
  endpoints, status lines, output styles, SSRF-guarded webfetch.

## [1.x] (Python, v1-python branch)
- Original agentic terminal coding agent: rich TUI, provider registry,
  sessions, compaction.
