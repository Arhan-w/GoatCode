# GoatCode

[![Build Status](https://github.com/Arhan-w/GoatCode/workflows/CI/badge.svg)](https://github.com/Arhan-w/GoatCode/actions)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

GoatCode is a powerful terminal AI agent that helps developers write, debug, and maintain code with advanced agentic capabilities.

## Features

- **Desktop Control**: Full computer interaction capabilities (click, type, scroll, launch apps)
- **Task Management**: Structured todo system for complex workflows
- **Update Checker**: Stay current with the latest features
- **Vision Support**: Analyze screenshots and interact with visual content
- **Parallel Tool Execution**: Optimized for efficiency with concurrent read operations
- **Subagent Orchestration**: Delegate complex tasks to specialized subagents

## Quick Start

### Installation

Using Bun (recommended):
```bash
bun add -g @goated/goatcode
```

Using npm:
```bash
npm install -g @goated/goatcode
```

### Basic Usage

Start an interactive session:
```bash
goat
```

Run a one-off command:
```bash
goat -p "Create a React component for a login form"
```

### Configuration

GoatCode automatically creates a configuration file at `~/.goatcode/config.json` on first run. For advanced configuration:

```bash
# Set your preferred model provider
goat config set provider openai

# Configure API keys securely
goat auth
```

## Advanced Features

### Desktop Control

GoatCode can interact with your desktop environment:

```bash
# Take a screenshot
goat -p "screenshot"

# Click at coordinates (after taking a screenshot)
goat -p "computer click x=500 y=300"
```

![Desktop Control Demo](videos/desktop-control.gif)
*Full desktop control capabilities - click, type, and interact with any application*

### Task Management

Create and manage structured tasks:

```bash
# Create a task list
goat -p "todo: [ {\"content\": \"Fix login bug\", \"activeForm\": \"Fixing login bug\", \"status\": \"in_progress\"} ]"
```

![Task Management](videos/task-management.gif)
*Structured task management workflow with real-time status updates*

### Vision Support

Analyze screenshots and interact with visual content:

```bash
# Take a screenshot and ask about it
goat -p "screenshot" && goat -p "What's visible in the screenshot?"
```

![Vision Support](videos/vision-support.gif)
*Vision analysis and interaction with screen content*

### Subagents

Delegate complex tasks:

```bash
# Run a research task in a subagent
goat -p "task: {\"description\": \"research\", \"prompt\": \"Find best practices for React authentication\", \"subagent_type\": \"explore\"}"
```

## Contributing

Contributions are welcome! Please see our [Contribution Guidelines](CONTRIBUTING.md).

### Development Setup

1. Clone the repository:
```bash
git clone https://github.com/Arhan-w/GoatCode.git
cd GoatCode
```

2. Install dependencies:
```bash
bun install
```

3. Build the project:
```bash
bun run build
```

4. Run tests:
```bash
bun test
```

## License

Distributed under the MIT License. See `LICENSE` for more information.

---

Made by Arhan. All rights reserved.