# goatcode-cli

The open-source terminal coding agent. **Any provider** (183), **your
subscriptions** (Claude Pro/Max, ChatGPT, Gemini, Copilot, Kimi, Grok via
OAuth), MCP servers, skills, plugins — and built-in **desktop control**
(see the screen, drive real apps). One standalone binary; this npm package
fetches it for your platform.

```bash
npm install -g goatcode-cli
goat
```

First steps once installed:

```
goat auth anthropic --key ***     # or: goat auth claude --oauth
goat auth --list-oauth                # Claude · ChatGPT · Gemini · Copilot · Kimi · Grok
goat -m openrouter/deepseek-ai/deepseek-v3.2 "explain @src"
```

Full docs, demo GIF, and the comparison vs Claude Code / Codex:
**https://github.com/Arhan-w/GoatCode**

MIT licensed. Binary is downloaded from
[GitHub Releases](https://github.com/Arhan-w/GoatCode/releases); nothing is
built or executed from source at install time. If the download is skipped
(offline, `--ignore-scripts`), `goat` fetches it on first run.
