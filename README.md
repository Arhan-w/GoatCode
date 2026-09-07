# 🐐 GoatCode

**Every provider. One terminal. Built for machines with 4 GB of RAM.**

GoatCode is an agentic coding CLI — it reads your codebase, edits files, runs
commands, and streams answers, talking to **180+ LLM providers** through one
interface. Log in with an API key **or** a subscription (Claude Pro/Max,
ChatGPT, Gemini, GitHub Copilot, Kimi, Grok) via browser OAuth — GoatCode
converts the web login into a working API credential and refreshes it for you.

```
goat > refactor the auth module to use the new token store
● grep  "def login"
● read  src/auth.py
● edit  src/auth.py
goat  Done — login() now delegates to TokenStore. Verify with: pytest tests/auth
```

## Why

- **Provider-agnostic.** One `provider/model` string switches between OpenAI,
  Anthropic, DeepSeek, Groq, OpenRouter, Ollama, and 175 more — no code changes.
- **Subscriptions, not just keys.** `goat auth claude --oauth` (or codex,
  gemini, github-copilot, kimi, grok) opens a browser, and your existing plan
  becomes an API credential. Tokens auto-refresh.
- **Custom endpoints.** Any OpenAI- or Anthropic-compatible URL (LM Studio,
  vLLM, a proxy, a company gateway) is one command away.
- **Low-end friendly.** No alt-screen redraw loop, no Electron, no Node.
  A scrollback-native streaming TUI — full import footprint measured at
  ~41 MB RSS, runs comfortably on 4 GB machines. `--plain` for SSH and
  dumb terminals.
- **Safe by default.** File writes, edits, and shell commands ask for approval
  unless you opt into `--auto`. File tools are sandboxed to the project root;
  bash runs with your user permissions — `--auto` trusts the model with your
  shell, so use it only in throwaway checkouts.

## Install

Requires Python 3.10+.

```bash
pip install goatcode        # or: pipx install goatcode
```

From source:

```bash
git clone https://github.com/Arhan-w/GoatCode && cd GoatCode
pip install -e .
```

## Quick start

```bash
# 1. Authenticate — pick one:
goat auth openai --key sk-...                      # API key
goat auth claude --oauth                           # Claude Pro/Max subscription
goat auth github-copilot --oauth                   # device flow, no browser redirect needed
goat endpoint add local --base-url http://localhost:1234/v1 \
    --format openai --api-key none --models qwen2.5  # LM Studio / vLLM / anything

# 2. Run:
goat                                               # interactive TUI
goat -m openrouter/deepseek-ai/deepseek-v3.2       # pick a model
goat -p "what does setup.py do?"                   # one-shot, scriptable
goat --auto -p "run the tests and fix failures"    # unattended
```

Environment variables work too: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GROQ_API_KEY`, … are picked up automatically for matching providers.

## The TUI

| Key / command | What |
|---|---|
| type + Enter | send to the agent |
| `Ctrl+C` | cancel generation |
| `/model <p/m>` | switch model mid-session |
| `/providers` `/models` | browse 180+ providers and their models |
| `/auth <p> --key K` / `--oauth` | add credentials without leaving the chat |
| `/new` `/sessions` `/resume <id>` | sessions persist to `~/.goatcode/sessions` |
| `/auto` `/approve` | toggle tool auto-approval |
| `/help` | everything |

## Providers & formats

GoatCode speaks four wire formats and maps every catalog entry to one:

| Format | Used by |
|---|---|
| `openai` | OpenAI + ~170 compatible endpoints (Groq, DeepSeek, OpenRouter, vLLM, Ollama, …) |
| `claude` | Anthropic Messages API (key or OAuth bearer) |
| `openai-responses` | OpenAI Responses API, ChatGPT Codex |
| `gemini` | Google Generative Language API |

The provider catalog is derived from
[OmniRoute](https://github.com/diegosouzapw/OmniRoute)'s registry; the
architecture (agent loop, tool dispatch, provider/model separation) is a
clean-room design in the spirit of
[opencode](https://github.com/anomalyco/opencode), reimplemented in Python.

## Configuration

`~/.goatcode/config.json` (user) and `./goatcode.json` (project) — project wins:

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "max_tokens": 8192,
  "auto_approve": false,
  "endpoints": {
    "ollama": {
      "base_url": "http://localhost:11434/v1",
      "format": "openai",
      "models": ["llama3.2", "qwen2.5"]
    }
  }
}
```

Env overrides: `GOAT_MODEL`, `GOAT_AUTO_APPROVE`, `GOAT_MAX_TOKENS`,
`GOATCODE_HOME` (relocate all state — useful on locked-down machines).

## Memory & low-end performance

- Streaming render, never buffering whole responses.
- Tool output capped (128 KB reads, 32 KB bash output) before it hits RAM.
- Context compaction drops old turns into a digest — no second LLM call.
- Dependencies: `httpx`, `rich`, `prompt_toolkit`. That's all.

## Development

```bash
pip install -e ".[dev]"
python -m pytest tests/ -q      # 47 tests, mocked transport, no network
```

## License

MIT
