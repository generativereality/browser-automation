---
name: browser
description: Launch and control a browser via Playwright MCP — navigate pages, click elements, fill forms, take snapshots, and automate web tasks. Use this when you need to interact with websites that require authentication or dynamic content.
---

# Browser Automation (Playwright MCP)

Control a real Chrome browser instance via Playwright MCP tools. The browser uses a persistent profile so logins, cookies, and preferences are preserved across sessions.

## Setup

Before using any `mcp__playwright__*` tools, ensure Chrome is running with remote debugging enabled.

Check if Chrome CDP is already available:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:9222/json/version
```

If it returns `000` or fails, launch Chrome:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome/PlaywrightClaude" \
  --no-first-run --no-default-browser-check 'about:blank' &
```

Wait for it to be ready:

```bash
for i in {1..10}; do
  curl -s -o /dev/null http://localhost:9222/json/version && echo "Ready" && break
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

1. Always check/launch Chrome first (see Setup above)
2. Navigate to the target URL with `browser_navigate`
3. Take a snapshot with `browser_snapshot` to see the page structure
4. Interact using `browser_click`, `browser_type`, etc. using refs from the snapshot
5. Take new snapshots after interactions to verify state changes

## Notes

- The `PlaywrightClaude` profile is separate from your normal Chrome profile — no conflicts
- Logins persist between sessions, so you only need to authenticate once per site
- For pages with complex DOMs (like Porkbun), prefer `browser_run_code` for DOM interaction over `browser_snapshot`
- Cloudflare dashboard pages load slowly — wait 3-5 seconds after navigation before taking snapshots
- Some pages show Turnstile challenges that appear as empty snapshots — retry or navigate directly
