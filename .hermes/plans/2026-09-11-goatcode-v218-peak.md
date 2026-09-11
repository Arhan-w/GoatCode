# GoatCode v2.1.8 — Peak Tier Plan (appended to approved base plan)

> **For Hermes:** base tasks 0–5 live in `2026-09-11-goatcode-v218-improvements.md` (approved). Peak tasks P1–P5 below slot in before Task 5 (release). Same rules: TDD, `bun test` + tsc + `render_repro.py` per task, commit per task.

**Goal:** Five features that don't just match Claude Code — they beat it, all wired into seams that already exist in the codebase (verified this session, no new deps).

**Why these are "peak":**
- Prompt caching = up to 90% cheaper long sessions. Claude Code does it; **nobody in the open-source CLI space exposes it**. Measurable in `/cost`.
- Real token meter (actual API usage, not char estimate) — Claude's is an estimate too.
- `/rewind` = conversation + files rewind to any turn. Claude Code shipped this in July 2025 as a headline feature; the checkpoint plumbing here already exists.
- Parallel subagents — Codex/Claude run one at a time. Multi-agent explore in one message = faster big-codebase answers.
- Session search across all history — neither competitor has it in-CLI.

---

## P1 — Anthropic prompt caching (cost: real money back)

**Objective:** Cache the system prompt + tool definitions on Anthropic requests; report cache savings in `/cost`.

**Verified seams:** `src/llm.ts:342-346` — `AnthropicClient.streamChat` builds `payload.system` as a plain string and sends `payload.tools`. Anthropic accepts `system: [{type:"text", text, cache_control:{type:"ephemeral"}}]` and `cache_control` on the last tool entry. 5-min TTL, hit = 10% input price.

1. `tests/core.test.ts`: unit-test the payload builder — with `cache: true` opt, `system` is a block array with `cache_control`, last tool carries `cache_control`; without it, byte-identical to today (zero regression risk for non-Anthropic).
2. `src/llm.ts`: add `cacheControl?: boolean` to stream options; Anthropic builder applies it. OpenAI/Gemini/xai paths untouched (their implicit caching needs nothing).
3. Parse `cache_read_input_tokens` / `cache_creation_input_tokens` from the usage event → extend `usage` shape `{prompt, completion, cacheRead?, cacheWrite?}` (llm.ts:89, agent.ts:29).
4. `src/pricing.ts`: `priceFor` gains cache math — `costUsd(usage, model)` treats `cacheRead` at 0.1×, `cacheWrite` at 1.25×.
5. `/cost` + `usage all`: show `⚡ cache: 1.2M tok read (saved ~$3.60)` line when nonzero.
6. Verify live: mock server can't prove it, so one real smoke via the freellmapi proxy (`goat -p` twice, same session, watch `cache_read` > 0 on turn 2). If proxy strips caching, ship behind config `cache_prompts: true` default-on for direct anthropic endpoints only.

**Files:** `src/llm.ts`, `src/pricing.ts`, `src/agent.ts`, `src/commands.tsx`, `src/config.ts` (flag), tests.

## P2 — True context meter (upgrade of approved Task 4)

**Objective:** Footer `ctx 34%` from **actual prompt tokens** (last turn's `usage.prompt` + cache tokens) against the model's window — not the char estimate.

**Verified seams:** `session.usage.in/out` accumulates real tokens (agent.ts:297-300); usage event already yields per-turn numbers.

1. `src/context.ts`: `contextWindow(modelId)` map — anthropic 200k, openai 400k (gpt-5)/128k default, gemini 1M, deepseek 128k, xai 128k, config override `context_window`.
2. Agent tracks `lastPromptTokens` (real, from final usage of the turn) → TUI footer reads it; falls back to char estimate only before the first response.
3. `/context` reuses the same function (DRY with Task 4's extraction).
4. Tests: window map, fallback, percent math.

**Files:** `src/context.ts` (new), `src/agent.ts`, `src/tui.tsx`, `src/commands.tsx`, tests.

## P3 — `/rewind` (conversation + files, per turn)

**Objective:** `/rewind [n]` — jump the session back n turns (default: picker list). Restores BOTH the transcript and all file mutations since that point. `/undo` today only reverts files of the last turn; this is the full Claude-Code-grade feature.

**Verified seams:** `tools.ts:257-284` — `checkpoints[]` (turn boundaries into `snaps[]`), `undoCheckpoint()` pops+reverts. `session.messages` is the transcript; `session.save()` persists.

1. `src/session.ts`: record `turnMarks: number[]` (message-count at each user-turn start) alongside save/load — old sessions without marks degrade gracefully (rewind disabled per entry).
2. `src/tools.ts`: `rewindTo(turnIndex)` — revert snaps back to that checkpoint AND drop the consumed checkpoint entries.
3. `src/commands.tsx` `/rewind`: no arg → list last 10 turns (`#7 · fix the parser · 2m ago`); `/rewind 7` → confirm dialog (y/n) → `rewindTo` + truncate `session.messages` to mark + push `⚠ rewound to turn 7 (3 files restored)`; then normal TUI continues from there.
4. Sentinel discipline (skill pitfall): one return shape — `{ok, files, msgs}` | null, grep all consumers.
5. Tests: mkdtemp file, 2 turns of edits, rewind to 1 → file content + message count both restored; rewind with no marks → clean error.

**Files:** `src/session.ts`, `src/tools.ts`, `src/commands.tsx`, `src/tui.tsx` (SlashIO wiring), tests.

## P4 — Parallel subagents (multi-explore in one message)

**Objective:** When the model issues 2+ `task` calls in one response, run them concurrently (each already gets a fresh Agent + own context — agent.ts:312+). 3 explore agents on a big repo = 3× faster research.

**Verified seams:** `agent.ts:162-165` batches CONCURRENT_SAFE tools; `spawnSubagent` is self-contained (own session object, own ToolKit? — verify it doesn't share `this.tools` state; if it does, give each spawn a fresh ToolKit rooted at same cwd).

1. Read `spawnSubagent` fully; confirm isolation (no shared snaps/checkpoints). Fix first if not.
2. Agent loop: extend the batch window — consecutive `task` calls join a parallel batch via `Promise.allSettled` (cap 3 concurrent, config `max_subagents`), each yields its own `tool_start`/`tool_end` pair (TUI already renders interleaved pushes fine).
3. Subagent progress line in TUI: `⧉ explore: <desc> (2 running)` — live-region safe (one line).
4. Tests: fake client that emits 2 task calls; assert both ran (order-independent results present) and wall-time overlap (start timestamps interleave).
5. System prompt (system-prompt.ts): one sentence — "issue multiple task calls in one message to run research in parallel."

**Files:** `src/agent.ts`, `src/tui.tsx`, `src/system-prompt.ts`, tests.

## P5 — Session search (`goat search` + `/search`)

**Objective:** Full-text search across every saved session; jump straight into a hit. Neither Claude Code nor Codex CLI has this.

**Verified seams:** sessions persist as JSONL under `~/.goatcode/sessions/` (session.ts save); `/sessions` + `/resume <id>` already exist.

1. `src/session.ts`: `searchSessions(query, home, limit)` — scan `*.jsonl` meta + user/assistant text (case-insensitive, snippet ±60 chars, newest-first by mtime). Pure fn, no deps.
2. `src/commands.tsx` `/search <q>`: top 8 hits — `id · date · first-user-line · …snippet with match…`; `/search resume 3` → reuses `/resume`.
3. `src/index.ts`: `goat search "query"` one-shot prints the same list.
4. Tests: write 3 synthetic session files in mkdtemp, assert ranking + snippet + skip of corrupt files.
5. `/help` + README features row.

**Files:** `src/session.ts`, `src/commands.tsx`, `src/index.ts`, tests.

---

## Execution order (peak first where they touch shared code)

Task 0 (aliases, staged) → P1 (caching, llm+pricing) → P2 (meter, builds on P1's usage shape) → Task 1 (diffs) → Task 2 (@complete) → Task 3 (always-allow) → P3 (rewind) → P4 (parallel subagents) → P5 (search) → Task 4 folds into P2 → Task 5 release v2.1.8 with TWO new demo GIFs: `/rewind` flow and cache-savings `/cost` panel (mock server gets `cache` + `rewind` demo modes).

**README peak section:** "⚡ Prompt caching — sessions get up to 90% cheaper as they grow" + rewind + parallel agents rows in the comparison table (all become ✓ vs their ✗/partial).

**Risks:**
- P1: proxy endpoints may strip `cache_control` → default-on only for `api.anthropic.com` + config override; verified live before shipping.
- P3: message truncation must keep tool_use/tool_result pairs intact (orphan tool_result = API 400) — rewind boundary is always a user-turn start, which is safe by construction; test asserts pairing.
- P4: shared ToolKit state is the deadlock risk (skill: one permission slot) — subagents run in `bypass` internally (they already must, verify) so no prompts; cap 3.
- Total ~900-1100 lines incl. tests. Every task independently shippable; if any one fails verification, drop it from the release, ship the rest.
