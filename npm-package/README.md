<div align="center">

# GoatCode v3.4.0
### The AI Coding Agent + IDE for the Terminal

[![CI](https://github.com/Arhan-w/GoatCode/actions/workflows/ci.yml/badge.svg)](https://github.com/Arhan-w/GoatCode/actions)
[![Release](https://img.shields.io/github/v/release/Arhan-w/GoatCode?color=a855f7&label=v3.4.0)](https://github.com/Arhan-w/GoatCode/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

*Every provider. A built-in Monaco IDE. Multi-repo workspaces. Code intelligence. Custom subagents. P2P collaboration.*

[**Quick Start**](#installation) · [**IDE**](#goatcode-ide) · [**Architecture**](#architecture) · [**Commands**](#slash-commands) · [**Docs**](https://github.com/Arhan-w/GoatCode/tree/v2-typescript/docs)

</div>

---

## What is GoatCode?

A professional coding agent that lives in your terminal — and now in a full web IDE. Powered by Bun and TypeScript, GoatCode combines **180+ LLM providers** (with intelligent failover chains and Anthropic prompt caching) with:

1. **Built-in Web IDE (`goat ide`)** — a Monaco-based IDE (the VS Code engine, MIT, vendored offline) with the same agent embedded: file explorer, tabs, live-streaming tool output, clickable permission cards, plan todos.
2. **Multi-Repo Workspaces** — mount multiple repositories simultaneously, run cross-repo searches (`/find`, `/index`), per-repo sandboxes.
3. **Code Intelligence Graph** — zero-config tree-sitter parser with WASM fallback (TS, JS, Python, Go, SQL, Rust…), incremental indexing, TF-IDF ranked symbol lookup, **hybrid semantic search** with local ONNX embeddings.
4. **Custom Subagents** — define agent personas as markdown (`~/.goatcode/agents/*.md`) with tool allowlists and model overrides; the main agent picks them automatically.
5. **Atomic Multi-Edit** — the `multiedit` tool applies ordered replacement hunks to one file all-or-nothing; a failed hunk writes nothing, one undo reverts everything.
6. **P2P Collaboration** — end-to-end encrypted WebSocket relay with Lamport sequencing, invite codes, turn tokens, live peer sync.
7. **Agent-as-a-Service** — JSON-RPC 2.0 over HTTP/WebSocket with constant-time token auth and remote agent mounting.
8. **Signed Plugin Marketplace** — ed25519-verified plugins with tar extraction guards and process sandboxing.
9. **Goated-Flash-Free** — zero-config built-in free tier: with no API key, GoatCode auto-boots an embedded free inference engine.
10. **Circuit-Breaker Failover** — automatic mid-stream provider switching with per-provider health tracking.
11. **Live Tool Streaming** — bash/build output streams into the UI in real time (`ctrl+j` for the full transcript in the TUI).
12. **Crash Recovery** — append-only atomic session persistence; resume interrupted work via `/recover`.

---

## Installation

```bash
npm install -g goatcode-cli
```

Or run without installing:

```bash
npx goatcode-cli
```

Precompiled binaries (including IDE bundles) for Windows/Linux/macOS on the [Releases page](https://github.com/Arhan-w/GoatCode/releases).

---

## Quick Start

1. **Run it — that's the whole setup.** No key configured? GoatCode boots on **Goated-Flash-Free** (embedded free model):
   ```bash
   goat
   ```

2. **Add a real provider** whenever you want (switch is automatic):
   ```bash
   goat auth openai sk-...
   ```
   Model aliases work: `/model sonnet`, `/model opus`, `/model flash` (free).

3. **Build the code index, search symbols:**
   ```text
   /index
   /find resolveRepos
   ```

4. **Launch the IDE:**
   ```bash
   goat ide
   ```

5. **Diagnostics:**
   ```text
   /doctor
   ```

---

## GoatCode IDE

```bash
goat ide          # opens http://127.0.0.1:<port>/?token=...
```

- **Editor** — Monaco with the noir theme, tabs, dirty markers, Ctrl+S save, TypeScript/JSON/HTML/CSS language services, 90+ language modes
- **Agent chat** — the exact engine from the terminal; tools stream live, edits refresh the explorer
- **Modes** — ask / accept-edits / plan / bypass from the title bar
- **Local-only** — binds 127.0.0.1 with a per-boot token

`--port N` picks a port; `--no-open` skips the browser.

---

## Custom Subagents

```markdown
# ~/.goatcode/agents/reviewer.md
---
description: Reviews diffs for bugs and security issues
tools: read, grep, glob
---
You are a meticulous code reviewer. Report only real defects…
```

```text
/agents        # list available subagents
```

The main agent sees the descriptions and spawns them via `task subagent_type=reviewer`. Tool allowlists are enforced at dispatch. See [docs/AGENTS.md](https://github.com/Arhan-w/GoatCode/blob/v2-typescript/docs/AGENTS.md).

---

## Comparison

| Feature | GoatCode | Claude Code | Codex CLI | OpenCode |
| :--- | :---: | :---: | :---: | :---: |
| **Providers** | **180+** | Anthropic only | OpenAI only | Multi |
| **Built-in IDE** | ✅ Monaco web IDE | ❌ | ❌ | ❌ |
| **Multi-Repo Workspace** | ✅ | ❌ | ❌ | ❌ |
| **Code Intelligence** | ✅ Tree-sitter + semantic | ❌ | ❌ | ❌ |
| **Custom Subagents** | ✅ markdown-defined | ❌ | ❌ | ❌ |
| **Collab & Relay** | ✅ P2P + invite codes | ❌ | ❌ | ❌ |
| **Agent-as-a-Service** | ✅ JSON-RPC 2.0 | ❌ | ❌ | ❌ |
| **Free Tier** | ✅ Built-in | ❌ | ❌ | ❌ |
| **License** | **MIT** | Proprietary | Proprietary | MIT |

---

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/help` | List all commands and shortcuts |
| `/model <name>` | Switch model or alias (`opus`, `sonnet`, `flash`) |
| `/ide` *(planned alias: `goat ide`)* | — use `goat ide` from your shell |
| `/index` / `/find` | Build & search the multi-repo code graph |
| `/diff` | Every file change this session (+/- lines per file) |
| `/agents` | List custom subagents |
| `/ultraplan` | Fan out to parallel scouts, merge one plan |
| `/share` / `/peers` / `/handoff` | P2P collaboration session |
| `/rewind` / `/undo` | Roll back transcript and/or files |
| `/fork` / `/recover` | Branch sessions / crash recovery |
| `/marketplace` | Signed community plugins |
| `/doctor` | 8-point system health check |
| `/compact` | Summarize old context to free space |

---

## Architecture

```tree
src/
├── agent.ts       # Agent loop: parallel scheduling, retry, fallback, subagents
├── ide/           # GoatCode IDE — Monaco web editor + embedded agent server
├── agents/        # Custom subagent loader (.goat/agents/*.md)
├── code/          # Tree-sitter indexer, semantic embeddings, hybrid search
├── collab/        # P2P relay, Lamport sync, invite codes
├── protocol/      # JSON-RPC 2.0 server & remote agent client
├── plugins/       # Signed marketplace, sandbox isolation
├── tools.ts       # read/write/edit/multiedit/bash(grep|glob)/web/undo
├── session.ts     # Atomic JSONL persistence, crash recovery, branching
├── llm.ts         # 4 wire formats: openai / claude / responses / gemini
├── providers.ts   # 180+ provider catalog, rate limiting
└── tui.tsx        # Ink TUI — noir theme, live tool streaming
```

Run tests: `bun test`

---

## License

MIT License © 2026 Arhan (Goated). See [LICENSE](LICENSE).
