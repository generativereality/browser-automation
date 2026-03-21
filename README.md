# browser-automation

Claude Code plugin for browser automation. Launches Chrome with a persistent profile and connects via CDP for full browser control.

## Install

```bash
/plugin marketplace add generativereality/plugins
/plugin install browser-automation@generativereality
```

## What it does

- Registers a browser automation MCP server (connects to Chrome via CDP on port 9222)
- Provides a `/browser` skill with setup instructions and available tools
- Uses a persistent Chrome profile so logins and cookies survive across sessions

## Usage

Once installed, Claude Code can:

1. Launch Chrome with remote debugging if not already running
2. Navigate to any website, take snapshots, click, type, and automate
3. Work with authenticated sessions (Cloudflare, Porkbun, GitHub, etc.)

Just ask Claude to interact with a website and it will use the browser tools automatically.

## Requirements

- **Node.js** (v18+) — needed to run `npx @playwright/mcp`
- **Google Chrome** installed at `/Applications/Google Chrome.app`
- macOS (Chrome launch command is macOS-specific)

If Node.js is not installed, the Playwright MCP server will fail to start. The `/browser` skill includes detection and installation instructions.
