---
name: browser
description: Drive a real browser from the shell via `playwright-cli` — open pages, click, type, fill forms, evaluate JS, capture snapshots, and persist auth across sessions. Use this whenever you need to interact with a web page (especially behind a login) and there's no CLI or API that already covers the task.
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(npm:*)
---

# Browser automation via `playwright-cli`

This skill drives the browser through Microsoft's official `@playwright/cli` — a plain CLI, no MCP server. Each invocation is a normal Bash call that returns a page snapshot reference on stdout.

## When to reach for this

- You need to interact with a dashboard, form, or app that has no API or no public CLI.
- An action is gated behind interactive login or session cookies.
- You need to scrape behind auth, or capture a screenshot/PDF of a rendered page.

If a vendor-specific CLI exists (`gh`, `stripe`, `wrangler`, `hf`, etc.), prefer that. The browser is the last resort, not the first.

## One-time setup (per machine)

```bash
npm install -g @playwright/cli@latest
playwright-cli install              # downloads ffmpeg, detects browsers
playwright-cli install-browser      # optional: skip if Chrome is already on the system
```

Verify:

```bash
playwright-cli --version
```

If `playwright-cli` isn't on PATH, fall back to `npx --no-install playwright-cli <command>`.

## First-time setup per workspace: write sane defaults

Before opening any browser, ensure `.playwright/cli.config.json` exists in the working directory with the recommended defaults:

```json
{
  "outputDir": ".browser-automation",
  "browser": {
    "launchOptions": {
      "headless": false
    }
  }
}
```

Why these two settings:

- **`outputDir: ".browser-automation"`** — snapshots, screenshots, console logs, and traces all land there instead of the default `.playwright-cli/`. Matches the gitignored convention from the previous plugin.
- **`headless: false`** — browser opens visibly by default. Almost every real browser-automation task needs to handle interactive auth (BankID, OAuth, 2FA, CAPTCHA, etc.); a headless default just means every command needs `--headed` and the user can't see what's happening. Make it the default.

Also add to `.gitignore`:

```
.browser-automation/
.playwright/
```

The `.playwright/` daemon-state dir is created at first `open`; the config file is the only thing in there worth keeping under version control (but the daemon state inside isn't).

## The full command reference is shipped with the CLI

`@playwright/cli` ships its own SKILL.md with every command, every flag, and worked examples. Read it on demand instead of duplicating it here — find the exact path in the first lines of `playwright-cli --help` (the `Agent skill:` line, typically under `node_modules/@playwright/cli/node_modules/playwright-core/lib/tools/cli-client/skill/SKILL.md`).

Touch points worth remembering from that file:

| Need | Command |
|---|---|
| Start a managed browser | `playwright-cli -s=<name> open [url]` — launches a new Playwright-managed Chrome |
| Attach to an existing CDP Chrome | `playwright-cli -s=<name> attach --cdp=http://localhost:9223` |
| Navigate inside an already-open/attached session | `playwright-cli -s=<name> goto https://example.com` |
| Get refs for clicking | `playwright-cli snapshot` — returns `e1`, `e2`, … refs |
| Click / type / fill | `playwright-cli click e5`, `playwright-cli fill e7 "value" --submit` |
| Run JS in the page | `playwright-cli eval "document.title"` |
| Save / restore auth | `playwright-cli state-save auth.json` → later: `state-load auth.json` |
| Inspect network | `playwright-cli requests` then `request <n>` |
| Pipe just the value | `playwright-cli --raw cookie-get session_id` |
| Detach (keep external browser running) | `playwright-cli detach` |
| Close | `playwright-cli close` |

> **⚠️ `open` vs `goto` — the one footgun to remember.** `open` *creates a browser*; `goto` *navigates the current one*. After `attach`, **never** use `open <url>` to "go somewhere" — playwright-cli 0.1.x silently spawns a fresh headless in-memory Chrome (temp profile, no cookies, attached browser sits idle, session's `attached` flag flips to `false`). Use `goto` instead. If you're unsure whether a session exists, `playwright-cli list` tells you.

## Picking the right browser source

There are three ways to get a browser. Try them in this order:

### 1. Attach to a running Chrome on port 9223 (best when available)

If a long-running Chrome instance is already up with `--remote-debugging-port=9223` (the convention this plugin grew up with), attach to it. All existing logins, cookies, and tabs are reused immediately — no re-auth, no profile copy, no risk of losing state.

How to know whether one is running:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9223/json/version
# 200 → attach. 000 or non-200 → no CDP browser available, launch one (below) or fall through to (2)/(3).
```

#### Launching the canonical Chrome on :9223 (when one isn't already running)

The plugin ships `scripts/launch-chrome.sh`, which is the single source of truth for this command. It's idempotent — safe to call even when Chrome is already up — and on macOS uses the conventional profile path `$HOME/Library/Application Support/Google/Chrome/browser-automation`:

```bash
# From the plugin checkout:
./scripts/launch-chrome.sh

# Or, equivalent one-liner if you don't have the plugin checked out:
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome/browser-automation" \
  --no-first-run --no-default-browser-check 'about:blank' \
  >/tmp/chrome-9223.log 2>&1 & disown
```

Override the profile path via `BROWSER_AUTOMATION_PROFILE=...` if needed. The script waits up to 5s for the CDP endpoint to come up before returning.

#### Attaching

```bash
playwright-cli -s=session-name attach --cdp=http://localhost:9223
```

Then navigate **with `goto`, not `open`** (see the footgun callout in the touch-points table above):

```bash
playwright-cli -s=session-name goto https://example.com
playwright-cli -s=session-name snapshot
```

Verify the attach actually held, especially if a previous run might have left the session in a weird state:

```bash
playwright-cli list --json | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["browsers"][0]["attached"]))'
# true → good. false → see "Known upstream gotchas" below.
```

When you're done, **`detach`** instead of `close` — `close` may terminate the external browser the user is sharing with you.

```bash
playwright-cli -s=session-name detach
```

### 2. Launch a managed Chrome on an existing profile

If no CDP-enabled Chrome is running, launch a fresh Playwright-managed Chrome but point it at an existing persistent profile dir:

```bash
playwright-cli -s=session-name open https://example.com \
  --profile="$HOME/Library/Application Support/Google/Chrome/browser-automation"
```

The profile must not be in use by another Chrome process — Chrome will refuse to start with a locked profile. (`open` is fine here because there is no session yet — see the footgun callout for why `open` is wrong *after* a session is already attached.)

### 3. Launch a fresh in-memory profile (only when no persistence is needed)

```bash
playwright-cli -s=session-name open https://example.com
```

Useful for smoke tests and one-shot scrapes where you don't care about cookies after the run.

## The patterns that matter at parallel scale

### Named sessions — one per Claude Code tab

Multiple concurrent Claude Code sessions stomping on a single shared browser is a recipe for confusion. Use a named session per tab so each one has its own isolated browser + storage:

```bash
playwright-cli -s=tab1 attach --cdp=http://localhost:9223    # or `open` if no CDP Chrome
playwright-cli -s=tab1 goto https://app.example.com
playwright-cli -s=tab1 snapshot
playwright-cli -s=tab1 detach                                # or `close` if managed
```

Or set the session name once for the whole Claude Code session via env var so you don't have to repeat the flag:

```bash
export PLAYWRIGHT_CLI_SESSION="$(basename "$PWD")-$(date +%s)"
playwright-cli attach --cdp=http://localhost:9223
playwright-cli goto https://app.example.com
# every subsequent playwright-cli call in this shell uses that session
```

List or close sessions:

```bash
playwright-cli list
playwright-cli close-all
playwright-cli kill-all   # last resort for stale processes
```

### Authenticated dashboards — log in once, reuse forever

For sites where the same auth state will be reused across many runs (Cloudflare dashboard, Porkbun, GitHub web UI, anything without a real API):

```bash
# First time — interactive login (headed by default thanks to cli.config.json)
playwright-cli -s=cf attach --cdp=http://localhost:9223      # if a CDP Chrome is up
playwright-cli -s=cf goto https://dash.cloudflare.com        # navigate within the attached Chrome
# …or, fallback when no CDP Chrome is running:
# playwright-cli -s=cf open https://dash.cloudflare.com --profile="$HOME/Library/Application Support/Google/Chrome/browser-automation"

# (user completes login in the opened tab)
playwright-cli -s=cf state-save ~/.config/playwright-cli/cf-auth.json
playwright-cli -s=cf detach     # if attached; or `close` for managed

# Later runs — restore without re-logging-in
playwright-cli -s=cf attach --cdp=http://localhost:9223
playwright-cli -s=cf goto https://dash.cloudflare.com
# state-load only needed if not using the persistent profile that already carries the cookies:
# playwright-cli -s=cf state-load ~/.config/playwright-cli/cf-auth.json
```

Once authenticated, pull individual cookies for downstream `curl`/`fetch` calls:

```bash
TOKEN=$(playwright-cli --raw -s=cf cookie-get __Secure-3PSID)
curl -H "Cookie: __Secure-3PSID=$TOKEN" https://dash.cloudflare.com/api/v4/accounts
```

### Output files land in `.browser-automation/`

With the recommended `cli.config.json`, snapshots and screenshots are written under `.browser-automation/` in the current working directory. For shareable outputs, pass `--filename=absolute/or/relative/path.png` explicitly.

## Cleanup

```bash
playwright-cli detach         # release an attached external browser (leaves it running)
playwright-cli close          # close a managed session
playwright-cli close-all      # close every managed session
playwright-cli delete-data    # delete on-disk profile for a persistent session
```

There's no daemon to babysit between runs — the browser process is tied to the session and exits on `close`.

## Known upstream gotchas (`@playwright/cli` 0.1.x)

These are quirks of the upstream CLI, not bugs in this plugin. The plugin's job is to keep you from tripping on them.

- **`open` after `attach` silently replaces the session with a new headless in-memory Chrome.** If you `attach --cdp=...` and then run `open <url>`, the CLI spawns a fresh Playwright-managed Chrome with a temp `--user-data-dir` (`/var/folders/.../playwright_chromiumdev_profile-XXXX`), navigates *that* one, and flips your session's `attached` flag to `false`. Your originally-attached Chrome sits idle, cookies-less navigation hits auth walls, and `playwright-cli list` will show the session as no longer attached even though `attach` reported success seconds earlier. **Workaround:** after `attach`, only use `goto` to navigate. Reserve `open` for *creating* a brand-new managed session when nothing is attached.
- **`detach` errors with "session not attached" after the `open`-after-`attach` slip.** Once `open` has replaced an attached session with a managed in-memory one, the only cleanup is `playwright-cli -s=<name> close` (or `playwright-cli close-all`). The error message already points to `close`, so follow it.
- **Recovering a wedged session.** If `list` shows a session in a state you don't recognise — `attached: false` after a fresh attach, in-memory data dir, etc. — run `playwright-cli close-all` (or `playwright-cli -s=<name> close`) and re-attach from scratch. Persistent profile state on disk survives.

## Troubleshooting

- **`playwright-cli: command not found`** — install missed PATH; fall back to `npx --no-install playwright-cli` or re-run `npm install -g @playwright/cli@latest`.
- **`browser not installed`** — run `playwright-cli install-browser`.
- **No Chrome on :9223 to attach to** — run `./scripts/launch-chrome.sh` from the plugin checkout, or the equivalent one-liner from the "Launching the canonical Chrome on :9223" section above.
- **`Browser is already in use`** when launching with `--profile=...` — Chrome is already running on that profile. Either attach via CDP (preferred), or quit the existing Chrome before re-launching, or pass `--isolated` (loses state).
- **Session unexpectedly headless / no cookies after `attach`** — you almost certainly ran `open <url>` instead of `goto <url>` after attaching. See "Known upstream gotchas" above.
- **CAPTCHA / bot challenges** — expected on heavily-protected sites; re-run after pausing, or fall back to a vendor API/CLI if one exists.
- **Stale session** — `playwright-cli kill-all` then re-open. Persistent profile state on disk survives.
- **Snapshot looks empty after navigation** — the page is still loading. Re-run `snapshot` after a short wait or after a known element appears (`playwright-cli eval "document.readyState"`).
