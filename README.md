<div align="center">

# GoatCode v3.3.7
### 🐐 The Autonomous Multi-Repo AI Coding Agent for the Terminal

[![CI/CD](https://github.com/Arhan-w/GoatCode/actions/workflows/ci.yml/badge.svg)](https://github.com/Arhan-w/GoatCode/actions)
[![npm version](https://img.shields.io/npm/v/goatcode-cli?color=a855f7)](https://www.npmjs.com/package/goatcode-cli)
[![npm downloads](https://img.shields.io/npm/dm/goatcode-cli?color=a855f7)](https://www.npmjs.com/package/goatcode-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/Arhan-w/GoatCode?style=social)](https://github.com/Arhan-w/GoatCode)

*180+ LLM providers • Multi-repo workspaces • Real-time code intelligence • P2P collaboration • Plugin marketplace • Agent-as-a-Service*

[🚀 Quick Start](#-quick-start) · [📖 Docs](#-documentation) · [🎬 Demos](#-demos) · [🏗️ Architecture](#-architecture--development) · [💬 Contribute](#-contributing)

</div>

---

## ⚡ Why GoatCode?

GoatCode is **the only AI coding agent** that gives you:

✅ **180+ LLM Providers** — Use OpenAI, Anthropic, Gemini, Meta, Hugging Face, Ollama, or custom APIs  
✅ **Multi-Repo Workspaces** — Index and search across multiple repositories simultaneously  
✅ **Code Intelligence Graph** — Zero-config tree-sitter AST parsing with semantic embeddings  
✅ **Real-Time Collaboration** — P2P WebSocket relay with Lamport clock synchronization  
✅ **Agent-as-a-Service** — Deploy as JSON-RPC 2.0 service with remote tool mounting  
✅ **Signed Plugin Marketplace** — Community plugins with Ed25519 signature verification  
✅ **Zero Setup (Goated-Flash-Free)** — Works immediately with embedded free LLM  
✅ **Smart Provider Failover** — Automatic circuit breaker when providers fail  
✅ **MIT Licensed** — Open source, no vendor lock-in  

---

## 🎯 What Can You Do?

**Code Across Your Entire Workspace**
```bash
/index          # Build multi-repo code graph
/find Parser    # Ranked symbol search with semantic matching
/ultraplan      # Decompose goals into parallel subagent scouts
```

**Collaborate in Real-Time**
```bash
/share          # Generate invite code for teammates
/peers          # See who's connected
/handoff        # Transfer turn control to a peer
```

**Recover & Branch Conversations**
```bash
/fork           # Branch conversation with shared history
/recover        # Resume after crashes with pending tool replay
/rewind         # Jump back to any checkpoint
```

**Troubleshoot Anything**
```bash
/doctor         # 8-point system health check
/model          # Switch LLM providers mid-conversation
/permissions    # Fine-grained security rules
```

---

## 📊 Feature Comparison

| Feature | GoatCode | Claude Code | Cursor | OpenCode |
| :--- | :---: | :---: | :---: | :---: |
| **LLM Providers** | **180+** | Anthropic only | Closed | Multi |
| **Multi-Repo Workspace** | ✅ | ❌ | ❌ | ❌ |
| **Code Intelligence** | ✅ Tree-sitter + Semantic | ❌ Basic | Limited | ❌ |
| **Live Collaboration** | ✅ P2P Relay | ❌ | ❌ | ❌ |
| **Plugin Marketplace** | ✅ Signed plugins | ❌ | ❌ | ❌ |
| **Session Branching** | ✅ `/fork` | ❌ | ❌ | ❌ |
| **Agent-as-a-Service** | ✅ JSON-RPC | ❌ | ❌ | ❌ |
| **Open Source (MIT)** | ✅ | ❌ | ❌ | ✅ |
| **Terminal-Native** | ✅ Ink TUI | ❌ | ❌ | ❌ |
| **Free Tier** | ✅ Built-in | ❌ | ❌ | ❌ |

---

## 🚀 Quick Start

### 1️⃣ Install (30 seconds)

```bash
# Global install (recommended)
npm install -g goatcode-cli

# Or use without installing
npx goatcode-cli

# Or grab a binary from releases
# https://github.com/Arhan-w/GoatCode/releases
```

### 2️⃣ Run (0 setup!)

```bash
goat
```

**That's it.** GoatCode boots with **Goated-Flash-Free** (embedded free LLM). Start coding immediately.

### 3️⃣ Add Your Provider (optional)

When you're ready, connect your own API key:

```bash
goat auth openai sk-...
goat auth anthropic sk-ant-...
goat auth gemini sk-...
# ... or 180+ other providers
```

Switch models anytime:
```text
/model flash              # Back to free
/model gpt-4             # OpenAI GPT-4
/model claude-3.7-sonnet # Anthropic Claude
/model gemini-2.0-flash  # Google Gemini
```

### 4️⃣ Index Your Codebase

```text
/index          # Parse all files, build symbol index
/find MyClass   # Search ranked symbols across repos
```

### 5️⃣ Invite Your Team

```text
/share          # Get invite code
# Send code to teammate → they run `goat join <code>`
```

---

## 📖 Documentation

| Document | Purpose |
| --- | --- |
| **[Getting Started](docs/GETTING_STARTED.md)** | Installation, first run, basic commands |
| **[Commands Reference](docs/COMMANDS.md)** | Complete slash command documentation |
| **[Architecture](docs/ARCHITECTURE.md)** | System design, modules, and internals |
| **[API & JSON-RPC](docs/API.md)** | Run as a service, remote agent mounting |
| **[Contributing](CONTRIBUTING.md)** | How to develop, test, and contribute |
| **[FAQ](docs/FAQ.md)** | Common questions and troubleshooting |

---

## 🎬 Demos

**[🎥 Launch Reel (60s)](https://github.com/Arhan-w/GoatCode/releases/download/v3.2.0/reel_landscape.mp4)** — See GoatCode in action

### Multi-Repo Code Intelligence
![Code Intelligence](docs/assets/demo-code.gif)
*`/index` builds the workspace graph, then `/find x` ranks symbols with hybrid keyword + semantic search.*

### Real-Time P2P Collaboration
![Collaboration](docs/assets/demo-collab.gif)
*Generate an invite code and collaborate live — presence, turn tokens, and live chat.*

### Zero-Config Free LLM
![Goated-Flash-Free](docs/assets/demo-flash.gif)
*No API key? No problem. Built-in free model works instantly on your machine.*

### Parallel Subagent Execution
![Ultraplan](docs/assets/demo-ultra.gif)
*`/ultraplan <goal>` decomposes tasks into parallel scouts that fan out and synthesize a plan.*

### Crash Recovery & Session Branching
![Crash Recovery](docs/assets/demo-recover.gif)
*Sessions persist to disk. Resume after crashes, fork conversations, and track all branches.*

### Provider Failover
![Failover](docs/assets/demo-failover.gif)
*Circuit breaker detects repeated failures and automatically switches providers mid-stream.*

---

## 🏗️ Architecture & Development

GoatCode is built with clean, modular **TypeScript** and **Bun**:

```
src/
├── agent.ts              # Main agent loop & subagent orchestration
├── agent-enhanced.ts     # ReAct & Plan-and-Execute patterns
├── code/                 # Code intelligence
│   ├── indexer.ts        # Tree-sitter AST parsing + WASM fallback
│   ├── find.ts           # Ranked symbol search (keyword + semantic)
│   ├── semantic.ts       # ONNX MiniLM-L6-v2 embeddings
│   └── grammars.ts       # Language grammars (TS, JS, Python, Go, etc.)
├── collab/               # P2P Collaboration
│   ├── relay.ts          # WebSocket relay & Lamport clock
│   └── invite.ts         # Invite code generation
├── protocol/             # Agent-as-a-Service
│   ├── jsonrpc.ts        # JSON-RPC 2.0 server
│   └── remote.ts         # Remote tool mounting
├── plugins/              # Plugin System
│   ├── loader.ts         # Signed tar+gzip extraction
│   ├── sandbox.ts        # Plugin sandboxing with resource limits
│   └── marketplace.ts    # Marketplace integration
├── tools.ts              # File, search, shell, workspace tools
├── session.ts            # Append-only JSONL persistence, crash recovery
├── llm.ts                # LLM provider abstraction, streaming, rate limiting
├── providers.ts          # 180+ provider catalog with lazy loading
├── doctor.ts             # System diagnostics (8-point health check)
├── palette.tsx           # Command palette (Ctrl+P)
├── virtual-list.tsx      # Windowed TUI list rendering
├── onboarding.tsx        # First-run setup wizard
├── rate-limiter.ts       # Token bucket rate limiting
├── tui.tsx               # Ink-based TUI with noir theme
└── index.ts              # CLI entry point
```

### Development

```bash
# Clone and setup
git clone https://github.com/Arhan-w/GoatCode.git
cd GoatCode
bun install

# Run in dev mode
bun run src/index.ts

# Run tests
bun test

# Build binary
bun build --target=bun src/index.ts --outfile=goat
```

---

## 🔑 Key Features Deep Dive

### 🐐 GOAT Mode
Unchained execution with zero permission prompts — for when you need maximum velocity.
```bash
goat --bypass
```

### 💾 Prompt Caching (Anthropic)
Automatic ephemeral block wrapping cuts input costs by **90%** on repeated messages.

### 🔄 Smart Failover
Circuit breaker detects rate limits (429) and transient errors, automatically rotating to fallback models.

### 📊 Context Meter & `/rewind`
Real-time token usage progress bar. Roll back to any checkpoint in your conversation history.

### 🎨 Noir Terminal Theme
Dark panels (`#25262D`), true-black input box (`#000F08`), vibrant violet accents (`#a855f7`).

### 🔌 Plugin Marketplace
Secure plugin system with Ed25519 signature verification, path-traversal guards, and runtime sandboxing.

### 📈 8-Point Diagnostics
Run `/doctor` to check providers, configs, credentials, network, and more.

### 🧠 Semantic Code Search
Local ONNX-based MiniLM-L6-v2 embeddings (384-dim) for zero-API-cost code search.

### 🚀 Parallel Subagent Execution
Fan-out goals to up to 8 concurrent subagents with dependency-aware scheduling.

---

## 🛠️ Commands Reference

| Command | Description |
| :--- | :--- |
| `/help` | List all available commands and keyboard shortcuts |
| `/model <name>` | Switch active LLM or model alias |
| `/index` | Build/refresh multi-repo code intelligence index |
| `/find <symbol>` | Ranked symbol lookup across all repos |
| `/ultraplan <goal>` | Fan out to parallel scouts, merge one prioritized plan |
| `/share` | Generate invite code for live collaboration |
| `/peers` | List connected peers in session |
| `/handoff` | Transfer turn control to a peer |
| `/rewind` | Revert to previous checkpoint |
| `/permissions` | Manage security rules |
| `/marketplace` | Browse and install signed plugins |
| `/search` | Full-text search saved sessions |
| `/fork` | Branch conversation with shared history |
| `/recover` | Recover from crashes via pending tool replay |
| `/doctor` | Run 8-point system health check |
| `/compact` | Summarize old messages to free context |
| `/quit` | Exit GoatCode |

---

## 🤝 Contributing

We ❤️ contributions! Whether it's **bug fixes**, **new providers**, **plugins**, **docs**, or **ideas**, all are welcome.

- **Found a bug?** Open an [issue](https://github.com/Arhan-w/GoatCode/issues/new?template=bug_report.md)
- **Have an idea?** Open a [feature request](https://github.com/Arhan-w/GoatCode/issues/new?template=feature_request.md)
- **Want to code?** See [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 📜 License

MIT License © 2026 Arhan (Goated). See [LICENSE](LICENSE) for details.

---

<div align="center">

**[⬆ back to top](#goatcode-v337)**

Made with 🐐 by [Arhan](https://github.com/Arhan-w)

</div>
