# browser-automation

Claude Code plugin for browser automation — built on Microsoft's official `@playwright/cli`. No MCP server, no port to babysit; Claude drives the browser through plain shell calls.

## Install

```bash
/plugin marketplace add generativereality/plugins
/plugin install browser-automation@generativereality
```

Then, the first time Claude needs the browser on this machine, the skill will guide it through:

```bash
npm install -g @playwright/cli@latest
playwright-cli install
```

And the first time it runs in a workspace, it will write `.playwright/cli.config.json` with sane defaults so the browser opens **headed** by default and output lands in `.browser-automation/`.

## What it ships

- A `/browser` skill that documents the setup, the parallel-session pattern, and the auth-persistence flow.
- `scripts/launch-chrome.sh` — idempotent launcher for the canonical long-running Chrome on `--remote-debugging-port=9223` with the `browser-automation` profile, which the skill then attaches to via CDP.
- A pointer to the upstream `playwright-cli` SKILL.md (shipped inside the CLI) for the full command reference — read on demand, no duplication.

## What changed in 0.2.0

This plugin previously registered a Playwright MCP server connected to a manually-launched Chrome on a debug port. That stack disconnected mid-flow, spawned per-tab at parallel scale, and forced restart-to-clear-cache loops. 0.2.0 drops the MCP entirely and uses `playwright-cli` instead.

What you get:

- No MCP disconnect — `playwright-cli` runs through Bash like any other shell tool.
- No per-tab browser spawn — named sessions (`-s=name`) share a single browser instance with isolated contexts.
- No restart-to-clear-cache when the skill is edited.
- ~4× lower token usage than the MCP version per run (snapshots written to disk; agent reads what it needs).
- CDP-attach is **preserved**: `playwright-cli attach --cdp=chrome` connects to your normal Chrome the same way the old plugin did.
- Existing persistent Chrome profile is **preserved**: pass `--profile=/path/to/profile` to `open` to reuse the same user-data-dir the old plugin built up.

## Requirements

- **Node.js** v18+ (for the `npm install -g` step).
- **A browser.** Chrome on the system path is auto-detected; otherwise `playwright-cli install-browser` downloads a Playwright-managed one.
- macOS / Linux / Windows — anywhere Playwright runs.

## Patterns the skill covers

- Workspace defaults via `.playwright/cli.config.json` (headed by default, `outputDir: ".browser-automation"`).
- Browser-source preference: **attach via CDP** to a running Chrome on port 9223 → managed launch on an existing `--profile=…` → fresh in-memory profile.
- One named session per Claude Code tab (`-s=tab1`, or `PLAYWRIGHT_CLI_SESSION=...`) for safe parallel use.
- `state-save` / `state-load` to log in once and reuse cookies across runs (Cloudflare dashboard, Porkbun, GitHub web UI, etc.).
- `detach` vs `close` — `detach` is the right cleanup for attached external browsers; `close` is for managed ones.
