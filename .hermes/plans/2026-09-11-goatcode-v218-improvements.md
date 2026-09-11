# GoatCode v2.1.8 Improvement Plan

> **For Hermes:** execute task-by-task with TDD (tests in `tests/core.test.ts` first), verify with `bun test` + `bun x tsc --noEmit` + `docs/render_repro.py` after each UI task, commit per task, push to `v2-typescript` at the end.

**Goal:** Close the four remaining UX gaps between GoatCode and Claude Code / Codex, on top of the alias work already staged.

**Architecture:** Bun + TS + Ink TUI. All four items are additive to existing seams: `ToolKit.snap()` already stores before/after content (diff source), `useInput` already routes Tab to slash completions (extend to `@`), `permissions.ts` already gates every mutating call (add session-allow rules), footer already renders model·path·mcp·skills (add ctx%).

**Current state (verified this session):**
- `ba8e16e` = v2.1.7 shipped everywhere (npm 2.1.7 latest, release binaries, local installs). 87/87 tests, tsc clean.
- UNCOMMITTED in working tree: `src/config.ts` +22 lines — `MODEL_ALIASES` + `expandModelAlias()` wired into `splitModel()` (Task 0 finishes this).
- Parallel tool batches exist (`CONCURRENT_SAFE` = read/glob/grep/tasks).
- `tool_end` renders only `⎿ completed` + first result line — no diff.
- Tab completion: slash commands only. No `@file` completion.
- Permission prompts: approve/deny per call, no "always for this session".
- Footer: model · path · mcp · skills — no context-window meter.

---

## Task 0 — Finish model aliases (already half-staged)

**Objective:** Complete the uncommitted `MODEL_ALIASES` patch and make it user-visible.

**Files:** Modify `src/config.ts` (staged), `src/commands.tsx` (`/model` no-arg help), `src/index.ts` (`-m` flag path), `tests/core.test.ts`.

1. Test first: `expandModelAlias("sonnet") === "anthropic/claude-sonnet-4-5"`, unknown passthrough, case-insensitive; `splitModel` on `{model:"opus"}` sets provider `anthropic`.
2. `/model` with no arg: print current model + alias list (`sonnet · opus · haiku · gpt · codex · gemini · grok · deepseek`).
3. Verify `goat -m sonnet -p "hi"` resolves (mock server, port 31999).
4. Commit `feat: model aliases (/model opus, goat -m sonnet)`.

## Task 1 — Inline diff on write/edit (the big one)

**Objective:** After an `edit`/`write` tool_end, render a colored unified diff (green +, red -, gray context, max 12 lines + `… N more`) in history — like Claude Code shows.

**Files:** Create `src/diff.ts` (~40 lines, LCS line diff, pure fn), modify `src/tui.tsx` (`case "tool_end"` near line 353), `tests/core.test.ts`.

1. TDD `diff.ts`: `unifiedDiff(before, after): string[]` — lines prefixed `+`/`-`/` `; test add/remove/replace/no-change cases.
2. `ToolKit` already snapshots before/after in `snap()` — expose `lastDiff(name, args)` returning `{path, before, after} | null` from the newest snap record of the current turn (do NOT re-read files; snap data is authoritative).
3. In `tui.tsx` `tool_end` for `write`/`edit`: pull the diff, push `<DiffView>` (green/red/dim, cap 12 lines, `… +N -M more` footer). Cap counts toward the live-region budget rule — it renders via `push()` into Static, so it's safe by construction.
4. Guard: if snap skipped (file > MAX_SNAP_BYTES), fall back to today's one-line summary.
5. Verify with `docs/render_repro.py` (0 artifact frames) + a manual mock `write` demo.
6. Commit `feat: inline unified diff after write/edit (Claude-style)`.

## Task 2 — `@file` tab completion

**Objective:** Typing `@` + Tab completes to project files (gitignore-aware, capped 8, dirs get trailing `/`).

**Files:** Modify `src/tui.tsx` (completion `useEffect` ~line 670 + Tab handler ~line 664), reuse the existing glob walker in `src/tools.ts` (extract `listFiles(cwd, limit)` if not already exported).

1. Extract/verify a pure `listProjectFiles(cwd): string[]` (respects SKIP_DIRS; reuse for tests).
2. Completion effect: when the last token starts with `@`, completions = files whose path starts with the token minus `@`; keep slash behavior untouched.
3. Tab inserts completion in place of the `@token` (not whole-input replace — current handler replaces everything; fix that for both cases).
4. Test: `listProjectFiles` on a mkdtemp tree skips `.git`/`node_modules`; completion matcher unit test.
5. Commit `feat: @file tab completion`.

## Task 3 — "Always allow" permission rules

**Objective:** Permission prompt gains a third option: `a` = allow for session (per tool+target-prefix rule), persisted in memory only (never written to config — safety).

**Files:** Modify `src/permissions.ts` (rule store + matcher), `src/tui.tsx` (prompt UI: `y/n/a`), `src/agent.ts` if the ask-callback signature needs the extra outcome.

1. Read `src/permissions.ts` first (it exists; current shape unknown to this plan — adapt).
2. TDD: `allowRule("edit", "src/")` matches `src/a.ts`, rejects `docs/a.ts`; exact-path rule; bash NOT eligible for always-allow (only path-scoped tools: read/edit/write/glob/grep/webfetch domains).
3. Prompt: `[y]es [n]o [a]lways` — `a` pushes rule + auto-approves current call.
4. `/permissions` slash command: list active session rules (so it's visible, not magic).
5. Commit `feat: session-scoped always-allow permission rules + /permissions`.

## Task 4 — Context meter in footer

**Objective:** Footer shows `ctx 34%` (chars-based estimate vs COMPACT_TRIGGER_CHARS, same math as `/context`), amber >70%, red >90%.

**Files:** Modify `src/tui.tsx` (footer line ~770), reuse `/context` computation from `src/commands.tsx` (extract shared fn into `src/context.ts` if needed — DRY).

1. Extract `contextUsed(session): number` (0-1) — unit test with synthetic sessions.
2. Footer segment after model: `ctx {pct}%` colored by threshold.
3. Verify in `render_repro.py` frames (footer stays one line — no wrap regression at 96 cols).
4. Commit `feat: live context meter in status footer`.

## Task 5 — Release v2.1.8

1. Bump `src/constants.ts`, `package.json`, `npm-package/package.json` → 2.1.8 (version-bump checklist in skill references).
2. Full verify: `bun test`, `tsc --noEmit`, `render_repro.py` ×2 (read + long demo, 0 artifacts), `goat -p` smoke vs mock.
3. README: add aliases + diff + @completion + always-allow + ctx meter to Features; record ONE new demo GIF for the inline diff (mock `write` demo mode already exists — deterministic, docs/record_session.py).
4. Commit, tag `v2.1.8`, push `v2-typescript` + tag → CI builds 5 binaries (`gh run watch`).
5. Swap local installs (npm shim, D:\bin, ~/.goatcode/bin, npm-package/bin) from the release asset; `goat --version` ×3.
6. npm publish — needs the user's browser auth; hand them the one-liner.

---

## Risks / notes
- Task 1 diff must render through `push()` (Static history), never the live frame — live-region cap is the v2.1.6/2.1.7 ghost-box lesson.
- Task 3: `a` option must not appear for bash (arbitrary command ≠ rule scope).
- Task 2: current Tab handler replaces the whole input — fixing it for `@` also fixes slash completion mid-path; cover both in tests.
- All tasks independent; order 0→4 is by user-visible impact per effort.

**Estimated diff:** ~350-450 lines total incl. tests. No new deps.
