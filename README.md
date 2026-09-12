<div align="center">

# GoatCode v3.0.0
### The Autonomous Multi-Repo AI Coding Agent for the Terminal

[![CI](https://github.com/Arhan-w/GoatCode/actions/workflows/ci.yml/badge.svg)](https://github.com/Arhan-w/GoatCode/actions)
[![Release](https://img.shields.io/github/v/release/Arhan-w/Arhan-w/GoatCode?color=a855f7&label=v3.0.0)](https://github.com/Arhan-w/GoatCode/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

*Every provider. Multi-repo workspaces. Code intelligence graph. Secure P2P/relay collaboration. Agent-as-a-Service JSON-RPC.*

[**Quick Start**](#installation) · [**Architecture**](#architecture) · [**Commands**](#slash-commands) · [**Documentation**](#documentation)

</div>

---

## What is GoatCode v3?

GoatCode v3 is a major architectural leap designed for professional developers who demand complete control, sub-second code intelligence, and team collaboration without leaving their terminal. Powered by Bun and TypeScript, GoatCode combines **180+ LLM providers** (with intelligent fallback chains and Anthropic prompt caching) with four brand-new pillars:

1. **Multi-Repo Workspaces (`workspace.repos`)** — Mount multiple repositories simultaneously, run cross-repo searches (`/find`, `/index`), and enforce per-repo sandboxes and strict permission rule forms.
2. **Code Intelligence Graph (`src/code`)** — Zero-config tree-sitter parser with WASM fallback supporting TS, JS, Python, and Go. Incremental mtime+size fast path, atomic persistence, and TF-IDF ranked symbol lookup.
3. **P2P Collaboration Relay (`src/collab`)** — End-to-end encrypted WebSocket relay with Lamport timestamp sequencing, invite codes, turn-tokens, and live peer synchronization.
4. **Agent-as-a-Service Protocol (`src/protocol`)** — JSON-RPC 2.0 over HTTP (`POST /rpc`) and WebSocket with constant-time token auth, path-jailed execution, and remote agent mounting (`remote_<name>`).
5. **Signed Plugin Marketplace (`src/plugins`)** — Secure tar+gzip extractor with path-traversal/bomb guards and ed25519 signature verification against pinned keys.

---

## Key Features

- **🐐 GOAT MODE (`--bypass`)** — Unchained permission bypass with zero prompts and instant execution when you need maximum velocity.
- **Noir Terminal Theme** — Crafted with deep dark panels (`#25262D`), a true-black input box (`#000F08`), and vibrant violet accents (`#a855f7`).
- **Anthropic Prompt Caching** — Automatic ephemeral block wrapping (`cache_control: { type: "ephemeral" }`) cutting input costs by 90% on repeated turns.
- **Smart Failover & Retry** — Automatic rotation across fallback models when encountering rate limits (429) or transient server errors.
- **Context Meter & `/rewind`** — Real-time token usage progress bar and full checkpoint rollback for both conversation transcripts and modified files.

---

## Comparison

| Feature | GoatCode v3 | Claude Code | Codex CLI | OpenCode |
| :--- | :---: | :---: | :---: | :---: |
| **Providers** | **180+ (All OAI/Anthropic/Gemini + Custom)** | Anthropic only | OpenAI only | Multi |
| **Multi-Repo Workspace** | ✅ Native (`roots` map) | ❌ Single | ❌ Single | ❌ Single |
| **Code Intelligence** | ✅ Tree-sitter + WASM + Rank | ❌ Basic grep | ❌ Basic grep | ❌ Basic grep |
| **Collab & Relay** | ✅ Lamport Sync + Invite codes | ❌ None | ❌ None | ❌ None |
| **Agent-as-a-Service** | ✅ JSON-RPC 2.0 + Remote tools | ❌ None | ❌ None | ❌ None |
| **Signed Plugins** | ✅ Ed25519 + Tar + Bomb guard | ❌ None | ❌ None | ❌ None |
| **Pricing / License** | **MIT (Open Source)** | Proprietary | Proprietary | MIT |

---

## Installation

Install globally via npm (recommended):

```bash
npm install -g goatcode-cli
```

Or run directly without installing:

```bash
npx goatcode-cli
```

Or grab a precompiled binary for Linux, macOS, or Windows from the [Releases Page](https://github.com/Arhan-w/GoatCode/releases).

---

## Quick Start

1. Start GoatCode in your project root:
   ```bash
   goat
   ```
2. Configure your API key or use FreeLLMAPI:
   ```bash
   goat auth openai sk-...
   ```
3. Build the code index and search symbols:
   ```text
   /index
   /find resolveRepos
   ```
4. Share your session with a teammate:
   ```text
   /share
   ```

---

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/help` | List all available commands and shortcuts |
| `/model <name>` | Switch active model or model alias (`opus`, `sonnet`) |
| `/index` | Build or refresh the workspace code intelligence index |
| `/find <symbol>` | Ranked symbol lookup across all workspace repositories |
| `/share` | Generate an invite code and start a collab relay session |
| `/peers` | List connected peers in the active collab session |
| `/handoff` | Transfer the turn-token to a peer |
| `/rewind` | Revert transcript and modified files back to a previous turn |
| `/permissions` | Manage always-allow security rules for the current session |
| `/marketplace` | Browse and install signed community plugins |
| `/search` | Full-text search across all saved local sessions |
| `/quit` | Exit GoatCode |

---

## Architecture & Development

GoatCode is built with clean, modular TypeScript:

```tree
src/
├── agent.ts       # Main agent loop & subagent batching
├── code/          # Tree-sitter AST indexer & symbol ranking
├── collab/        # Lamport sync, websocket relay & invite codes
├── protocol/      # JSON-RPC 2.0 server & remote agent client
├── plugins/       # Signed plugin marketplace & security guards
├── tools.ts       # File, search, workspace and shell toolkit
├── tui.tsx        # Ink-based TUI with noir theme and streaming
└── index.ts       # CLI entry point and subcommands
```

Run tests locally:
```bash
bun test
```

---

## License

MIT License © 2026 Arhan (Goated). See [LICENSE](LICENSE) for details.
