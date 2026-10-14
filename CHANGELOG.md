# Changelog

All notable changes to GoatCode. Versions match git tags and npm releases.

## [3.4.0] - 2026-10-15
### Added
- **Custom subagent `model:` override** — custom agents (`.goat/agents/NAME.md`) can now declare `model: provider/model` in frontmatter to run on a different model than the parent. Resolved through the same credential/OAuth path.
- **Project-level agent priority** — `./.goat/agents/` and `./agents/` now take precedence over `~/.goatcode/agents/` when the same agent name exists in multiple roots (docs/AGENTS.md spec).
- **Windows postinstall fix** — npm installer now downloads the correct release assets (`goat-windows-x64.exe`, `goat-windows-x64-ide.zip`) with zip extraction via `tar -xf` / PowerShell `Expand-Archive`.
- **Doctor improvements** — `goat doctor` now checks version against `src/constants.ts` (single source of truth), uses global `fetch` (no more `node:fetch` crash), and retargets the MCP config type import to the live module.
- **Dead code cleanup** — removed 6 unused modules (`ui.ts`, `collab.ts`, `mcp-enhanced.ts`, `session-db.ts`, `skills.ts`, `types.ts`), pruned phantom ambient declarations (kept only `onnxruntime-node`/`@xenova/transformers` for semantic indexing), and eliminated duplicate comments/empty blocks in `tools.ts`, `tui.tsx`, `agent.ts`.
- **IDE server MIME fix** — vendored Monaco assets now serve the correct `content-type` based on the actual file found, not the first candidate path.
- **CI hardening** — `bun test --timeout 30000` to prevent cold-transpile flakes on CI.
- **Onboarding version fix** — first-run wizard now shows the actual `VERSION` instead of hardcoded `v3.2`, and uses template literals for the provider name in auth hints.

### Fixed
- npm postinstall: Windows asset name mismatch (was `goat.exe`, now `goat-windows-x64.exe` with `goat.exe` fallback).
- `goat doctor` crashed internally on `node:fetch` (swallowed per-provider, showed bogus "4/4 providers unreachable").
- Custom agent loader priority contradicted docs: user-level was winning over project-level.
- Custom agent `model:` frontmatter field was parsed but never used.
- Duplicate `ctrl+k` handler in TUI, dead `fdSync` in `tools.ts`, pointless delete-then-add for "task"/"undo" in `agent.ts`.
- `src/mcp/client.ts` type import pointed to deleted `types.ts` (now `config.ts`).
- `onboarding.ts` printed literal `${provider}` string and hardcoded "v3.2".

## [3.3.8] - 2026-10-14
### Added
- **GoatCode IDE (`goat ide`)** — a full local web IDE: vendored Monaco editor
  (the VS Code engine, MIT) in the noir theme, file explorer with tabs and
  dirty markers, and the same agent engine as the terminal in a chat panel —
  tools stream live, permission prompts are clickable cards, plan todos render
  inline. Local-only (127.0.0.1 + per-boot token), works fully offline.
- **`multiedit` tool** — apply several exact string replacements to one file
  atomically: all-or-nothing on any failed hunk, later hunks see earlier
  hunks' output, one undo reverts the whole batch.
- Release pipeline ships `*-ide.zip`/`.tar.gz` archives bundling the binary
  with the vendored Monaco assets; installers (install.ps1, install.sh, npm
  postinstall) extract them to `~/.goatcode/ide-vendor`.

### Fixed
- SSE parser regression from v3.2: the buffered rewrite re-added parsed lines
  into the read buffer (lost/duplicated deltas, hang on short streams). Back
  to the line-based parser with proper stream-final decode.
- Session persistence regression: `save()` is synchronous + atomic again
  (tmp+rename). The async append-style save wrote a full copy of the session
  on every call (quadratic growth) and callers never awaited it, dropping
  saves mid-turn. `load()` keeps legacy format compatibility.
- Print mode (`goat -p`) routed through a hollow `EnhancedAgent` that faked
  subagent results and ignored retry/fallback; now uses the real `Agent`.
- Version drift: npm-package metadata now tracks `src/constants.ts` exactly
  (enforced by test).
- IDE test no longer `chdir`s the runner into a temp dir it deletes (CI
  uv_cwd failures on Linux).

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
