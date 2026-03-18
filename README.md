# playwright-browser

Claude Code plugin for browser automation via [Playwright MCP](https://github.com/playwright-community/mcp). Launches Chrome with a persistent profile and connects via CDP for full browser control.

## Install

```bash
/plugin marketplace add generativereality/plugins
/plugin install playwright-browser@generativereality
```

## What it does

- Registers the Playwright MCP server (connects to Chrome via CDP on port 9222)
- Provides a `/browser` skill that explains setup and available tools
- Uses a persistent Chrome profile (`PlaywrightClaude`) so logins and cookies survive across sessions

## Usage

Once installed, Claude Code can:

1. Launch Chrome with remote debugging if not already running
2. Navigate to any website, take snapshots, click, type, and automate
3. Work with authenticated sessions (Cloudflare, Porkbun, GitHub, etc.)

Just ask Claude to interact with a website and it will use the browser tools automatically.

## Requirements

- Google Chrome installed at `/Applications/Google Chrome.app`
- macOS (Chrome launch command is macOS-specific)
