# Custom Subagents

Define reusable agent personas that the main agent can spawn via the `task`
tool (`subagent_type`). Each agent gets its own context window, its own tool
allowlist, and its own system prompt.

## Where they live

| Location | Scope |
|---|---|
| `~/.goatcode/agents/<name>.md` | all projects (user-level) |
| `./agents/<name>.md` | this project |
| `./.goat/agents/<name>.md` | this project |

Project-level agents with the same name win.

## Format

```markdown
---
description: Reviews diffs for bugs, security issues and style
tools: read, grep, glob
model: anthropic/claude-haiku-4-5
---

You are a meticulous code reviewer.

Rules:
- Report only real defects: bugs, security issues, race conditions.
- For every finding give file:line and a one-line failure scenario.
- Output a numbered list ordered by severity. No praise, no summary of the change.
```

### Frontmatter

| Field | Meaning |
|---|---|
| `description` | **required** — shown to the main agent so it knows when to pick this type |
| `tools` | comma-separated allowlist; omit = all tools. Enforced at dispatch: a tool outside the list is refused even if the model calls it |
| `model` | optional model override for this agent (e.g. route cheap work to Haiku) |
| `name` | defaults to the filename; must be a valid `subagent_type` string |

The markdown **body** is the agent's system prompt — its persona, rules and
required output format.

## Using them

The main agent sees the descriptions and picks a type automatically:

> task subagent_type=reviewer description="check the auth diff" prompt="Review src/auth.ts"

List what's available:

```
/agents
```

## Notes

- Custom agents never spawn sub-subagents and never touch undo state — those
  are blocked regardless of the allowlist.
- Combine with the plan flow: an `architect` agent (read-only) drafts the
  plan, then the main loop executes it.
