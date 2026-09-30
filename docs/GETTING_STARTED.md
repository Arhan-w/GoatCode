# Getting Started with GoatCode

Welcome to GoatCode! This guide will help you get up and running in minutes.

## Table of Contents

- [Installation](#installation)
- [First Run](#first-run)
- [Basic Commands](#basic-commands)
- [Connecting a Provider](#connecting-a-provider)
- [Next Steps](#next-steps)
- [Troubleshooting](#troubleshooting)

---

## Installation

### Via NPM (Recommended)

```bash
npm install -g goatcode-cli
```

Then start GoatCode:
```bash
goat
```

### Via NPX (No Install)

```bash
npx goatcode-cli
```

### Via Binary Release

Download a precompiled binary for your OS from the [Releases Page](https://github.com/Arhan-w/GoatCode/releases):
- **macOS**: `goat-macos-arm64` or `goat-macos-x64`
- **Linux**: `goat-linux-x64` or `goat-linux-arm64`
- **Windows**: `goat-windows-x64.exe`

Make it executable and add to PATH:
```bash
chmod +x goat-macos-arm64
mv goat-macos-arm64 /usr/local/bin/goat
```

---

## First Run

When you launch GoatCode for the first time, you'll see an **Onboarding Wizard**:

1. **Welcome Screen** — Overview of GoatCode features
2. **API Key Setup** (Optional) — Add your LLM provider credentials
3. **Workspace Configuration** — Select repositories to index
4. **Theme & Preferences** — Customize your TUI experience

If you skip the wizard, GoatCode boots with **Goated-Flash-Free** (embedded free LLM) immediately.

```bash
goat
# ✨ Welcome to GoatCode v3.3.7!
# 🐐 No API key configured — using Goated-Flash-Free
# Type /help to see all commands
```

---

## Basic Commands

### Start Coding

Once GoatCode is running, you can type naturally:

```
You: Refactor this TypeScript function for performance
GoatCode: [reads your code, suggests optimizations, makes edits]
```

### Try These First Commands

```text
/help              # See all commands and keyboard shortcuts
/model             # Switch LLM providers
/doctor            # Check your setup (providers, network, etc.)
/index             # Build code intelligence index
/find MyClass      # Search for symbols across your repos
```

### Common Keyboard Shortcuts

- `Ctrl+C` — Cancel current operation / Exit
- `Ctrl+P` — Open command palette with suggestions
- `Ctrl+L` — Clear screen
- `Tab` — Autocomplete

---

## Connecting a Provider

By default, GoatCode uses **Goated-Flash-Free** (free, built-in model). To use a different provider:

### OpenAI (GPT-4, GPT-3.5)

```bash
goat auth openai sk-proj-...
```

Then switch:
```text
/model gpt-4
```

### Anthropic (Claude)

```bash
goat auth anthropic sk-ant-...
```

Then switch:
```text
/model claude-3-7-sonnet
```

### Google Gemini

```bash
goat auth gemini AIza...
```

Then switch:
```text
/model gemini-2-0-flash
```

### Local LLMs (Ollama, vLLM)

```bash
goat auth ollama http://localhost:11434
```

Then switch:
```text
/model ollama/mistral
```

### View All Providers

```bash
goat auth list
```

---

## Indexing Your Codebase

To enable code search and cross-repo symbol lookup:

```text
/index
```

This will:
1. **Scan** all files in your workspace
2. **Parse** code with tree-sitter (TypeScript, JavaScript, Python, Go, etc.)
3. **Extract** symbols (functions, classes, variables)
4. **Build** a searchable index with semantic embeddings

Once indexed, you can search:

```text
/find resolveRepos    # Find all symbols matching "resolveRepos"
/find Parser          # Fuzzy search for classes/functions
```

---

## Collaborating with Your Team

### Generate a Shareable Invite

```text
/share
# Invite code: GOAT-ABC123XYZ
```

Share this code with teammates. They can join:

```bash
goat join GOAT-ABC123XYZ
```

Once connected:
- **See presence** — Who's online in the session
- **Pass turns** — Use `/handoff` to transfer control
- **Real-time sync** — Changes sync via P2P relay
- **Chat** — Communicate while coding

---

## Multi-Repo Workspaces

Work across multiple repositories simultaneously:

### Add Multiple Repos

```bash
goat -r ~/my-app ~/my-lib ~/shared-utils
```

Or configure in `workspace.config.json`:

```json
{
  "repos": [
    "~/my-app",
    "~/my-lib",
    "~/shared-utils"
  ]
}
```

Then search and edit across all repos:

```text
/index
/find SharedParser     # Searches all three repos
```

---

## Managing Sessions

### List All Sessions

```text
/search
```

Shows all saved conversations.

### Fork a Conversation

```text
/fork
```

Creates a branch of the current session with shared history up to this point.

### Recover from a Crash

If GoatCode crashes, resume with:

```bash
goat --recover
```

This replays any pending tool calls and restores your session state.

---

## Troubleshooting

### "No API key configured"

This is normal! GoatCode works with Goated-Flash-Free out of the box. To add a provider:

```bash
goat auth openai sk-...
```

### Commands aren't working

Check the onboarding wizard:

```bash
goat --setup
```

Or run diagnostics:

```text
/doctor
```

### Performance issues

Indexing a large codebase takes time. Monitor with:

```text
/doctor
```

To rebuild the index:

```text
/index --force
```

### Collaboration not working

Check network connectivity:

```text
/doctor
```

Ensure your firewall allows WebSocket connections.

### Provider rate limited

GoatCode automatically switches to a fallback model. Check status:

```text
/model
```

---

## Next Steps

1. **Read the [Commands Reference](COMMANDS.md)** — Deep dive into all slash commands
2. **Explore [Architecture](ARCHITECTURE.md)** — Understand how GoatCode works
3. **Run your first project** — Index your codebase and start asking questions
4. **Check the [FAQ](FAQ.md)** — Common questions answered
5. **Contribute** — See [CONTRIBUTING.md](../CONTRIBUTING.md) to help improve GoatCode

---

## Need Help?

- 💬 **GitHub Issues**: [Report bugs or request features](https://github.com/Arhan-w/GoatCode/issues)
- 📖 **Documentation**: [Full docs](.)
- 🐐 **Community**: Join our discussions on GitHub

Happy coding! 🚀
