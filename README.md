# GoatCode

[![Build Status](https://github.com/Arhan-w/GoatCode/workflows/CI/badge.svg)](https://github.com/Arhan-w/GoatCode/actions)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/goatcode-cli.svg)](https://www.npmjs.com/package/goatcode-cli)

<p align="center">
  <img src="docs/assets/demo-read.gif" alt="GoatCode demo - file read" width="720" />
</p>

GoatCode is a terminal AI coding agent built for developers who want speed, control, and total flexibility.

One binary. Any provider (183+). Your subscriptions (Claude Pro/Max, ChatGPT, Gemini, Copilot, Kimi, Grok). MCP servers. Skills. Plugins. Desktop control.

No account lock-in. No fluff.

---

## Install

```bash
npm install -g goatcode-cli
```

No npm? One line on any OS:

```bash
# Windows PowerShell
powershell -c "irm https://raw.githubusercontent.com/Arhan-w/GoatCode/v2-typescript/install.ps1 | iex"

# Linux / macOS / Git-Bash
curl -fsSL https://raw.githubusercontent.com/Arhan-w/GoatCode/v2-typescript/install.sh | bash
```

Then run `goat auth` and start with `goat`.

---

## Quick Start

```bash
# Start interactive session
goat

# One-off prompt
goat -p "Create a React login component"

# Piped stdin as context
cat error.log | goat -p "why did this fail?"

# Machine-readable output for scripts
goat -p "summarize @setup.py" --output-format json
```

## Screenshots

<p align="center">
  <img src="docs/assets/demo-read.png" alt="File read demo" width="720" />
</p>

<p align="center">
  <img src="docs/assets/demo-todo.png" alt="Todo tracking demo" width="720" />
</p>

<p align="center">
  <img src="docs/assets/demo-write.png" alt="File write demo" width="720" />
</p>

## What it does

- **Desktop control**: click, type, scroll, launch apps
- **Vision**: read screenshots and act on what's visible
- **Parallel tools**: concurrent reads, smart batching
- **Subagents**: delegate research, explore, and planning tasks
- **Skills & MCP**: plug in tools and workflows
- **Self-update**: update check built in
- **Print mode**: one-shot prompts with stdin piping + JSON output
- **Usage dashboard**: `goat usage all` for cross-session cost tracking

---

## Usage

```bash
# Screenshot
goat -p "screenshot"

# Click something
goat -p "computer click x=500 y=300"

# Analyze a screenshot
goat -p "What's visible on screen?"
```

## Providers

OpenAI, Anthropic, Google, Groq, Mistral, xAI, Together, Fireworks, DeepSeek, OpenRouter, Cloudflare, Voyage, LocalAI, Ollama, LM Studio, MLX, llama.cpp, and many more.

## Contributing

1. Clone: `git clone https://github.com/Arhan-w/GoatCode.git`
2. Install: `bun install`
3. Build: `bun run build`
4. Test: `bun test`

## License

MIT. See `LICENSE`.

---

Made by Arhan. All rights reserved.

