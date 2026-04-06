---
name: browser
description: Launch and control a browser via Playwright MCP — navigate pages, click elements, fill forms, take snapshots, and automate web tasks. Use this when you need to interact with websites that require authentication or dynamic content.
---

# Browser Automation (Playwright MCP)

Control a real Chrome browser instance via Playwright MCP tools. The browser uses a persistent profile so logins, cookies, and preferences are preserved across sessions.

## Prerequisites

Before using browser automation, two dependencies must be available:

### 1. Node.js

The Playwright MCP server requires Node.js (v18+) to run via `npx`.

Check if Node.js is installed:

```bash
which node && node --version
```

If `node` is not found, help the user install it. The recommended approach for macOS:

```bash
# Option A: Homebrew (most common)
brew install node

# Option B: If Homebrew is not installed either
curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash
brew install node
```

**IMPORTANT:** If Node.js is not installed, the `playwright` MCP server from this plugin will show as "failed" in `/plugin` status. Install Node.js first, then restart the Claude Code session for the MCP server to start.

### 2. Google Chrome

Chrome must be installed at `/Applications/Google Chrome.app` (macOS).

Check:

```bash
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Setup

Before using any `mcp__playwright__*` tools, ensure Chrome is running with remote debugging enabled.

Check if Chrome CDP is already available:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:9223/json/version
```

If it returns `000` or fails, launch Chrome:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9223 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome/browser-automation" \
  --no-first-run --no-default-browser-check 'about:blank' &
```

Wait for it to be ready:

```bash
for i in {1..10}; do
  curl -s -o /dev/null http://localhost:9223/json/version && echo "Ready" && break
  sleep 0.5
done
```

## Available Tools

Once Chrome is running, these Playwright MCP tools are available:

| Tool | Purpose |
|------|---------|
| `mcp__playwright__browser_navigate` | Navigate to a URL |
| `mcp__playwright__browser_snapshot` | Get an accessibility snapshot of the current page |
| `mcp__playwright__browser_click` | Click an element (by ref from snapshot) |
| `mcp__playwright__browser_type` | Type text into an input field |
| `mcp__playwright__browser_select_option` | Select from a dropdown |
| `mcp__playwright__browser_hover` | Hover over an element |
| `mcp__playwright__browser_drag` | Drag between elements |
| `mcp__playwright__browser_screenshot` | Take a screenshot |
| `mcp__playwright__browser_run_code` | Execute JavaScript in the page |
| `mcp__playwright__browser_wait` | Wait for a specified time |
| `mcp__playwright__browser_tab_list` | List open tabs |
| `mcp__playwright__browser_tab_new` | Open a new tab |
| `mcp__playwright__browser_tab_select` | Switch to a tab |
| `mcp__playwright__browser_tab_close` | Close a tab |

## Usage Pattern

1. Always check prerequisites (Node.js + Chrome) first
2. Launch Chrome with remote debugging if not running (see Setup above)
3. **Open a new tab** with `browser_tabs` (action: "new", url: target URL) — never navigate in an existing tab the user may be using
4. Take a snapshot with `browser_snapshot` to see the page structure
5. Interact using `browser_click`, `browser_type`, etc. using refs from the snapshot
6. Take new snapshots after interactions to verify state changes

## Troubleshooting

- **MCP server shows "failed"**: Most likely Node.js is not installed or not in PATH. Run `which node` to check. Install via `brew install node`, then restart Claude Code.
- **Chrome won't launch**: Verify Chrome is installed at `/Applications/Google Chrome.app`
- **Port conflict**: If port 9223 is in use, another Chrome debug instance may be running. Check with `lsof -i :9223`.
- **CAPTCHA challenges**: May appear as empty snapshots — retry or navigate directly

## Notes

- The `browser-automation` profile is separate from your normal Chrome profile — no conflicts
- Logins persist between sessions, so you only need to authenticate once per site
- For pages with very large or complex DOMs, prefer `browser_run_code` over `browser_snapshot`
- Some pages load slowly — wait a few seconds after navigation before taking snapshots
