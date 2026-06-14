---
name: browser
description: Drive a real browser from the shell via the `browser-automation` CLI — open pages, click, type, fill forms, read text, capture snapshots, all against one shared headed Chrome with a persistent profile (cookies + extensions survive). Daemonless and per-tab isolated, so many parallel Claude Code sessions can each drive their own tab without interfering. Use whenever you need to interact with a web page (especially behind a login) and there's no CLI or API that already covers the task.
allowed-tools: Bash(browser-automation:*) Bash(npm:*)
---

# Browser automation via `browser-automation`

A plain CLI — no MCP server, **no daemon, nothing long-lived to crash**. Every
command is a fresh process that opens a short-lived CDP connection to **one tab**,
acts, and exits. State that must survive between calls lives in two durable
places, neither of which is a process: the user's Chrome, and a tiny per-session
file under `~/.browser-automation/sessions/`.

## The model — read this first

- **One shared headed Chrome** on `--remote-debugging-port=9223` with a
  persistent profile (`browser-automation`). Cookies, logins, and **browser
  extensions (password managers, etc.) all persist** across runs and across
  Claude Code restarts. The user can watch and complete interactive auth in the
  same window.
- **Per-target CDP, not whole-browser.** The CLI talks to a single tab's
  `webSocketDebuggerUrl`. It never does Playwright-style "connect to the whole
  browser and enumerate every target" — so a stuck iframe/worker or a pile of
  open tabs can never wedge it (the failure that made `playwright-cli` time out).
- **Address any tab on demand.** Every page command picks its tab three ways
  (precedence `-t` > `-m` > `-s`):
  - `-m <substr>` — any open tab whose **URL or title** contains the substring
    (errors if ambiguous; `--first` to take the first). This is how you drive
    tabs the user or another flow already opened — no setup needed.
  - `-t <targetId>` — an exact tab (from `browser-automation list`).
  - `-s <name>` — a saved **session** bookmark.
- **Sessions are optional bookmarks, not locks.** `-s <name>` just remembers a
  `targetId` so you don't retype a selector; there's no 1-session-1-tab rule.
  Bind a name to an already-open tab with `bind -s name -m <substr>`. Parallel
  Claude Code sessions stay isolated by *convention* — each drives its own tab
  (its own `-s` name or `-m` match) — but any tab is reachable on demand.
- **No focus stealing.** New tabs are created in the background; the CLI never
  calls `Target.activateTarget` / `Page.bringToFront`. Your foreground app and
  sibling sessions are left alone.
- **Self-healing.** If the tab was closed (or Chrome restarted and reissued
  targetIds), the next `goto` just opens a fresh background tab for that session.
- **Refs live in the DOM.** `snapshot` stamps `data-ba-ref="e7"` onto each
  interactive element and returns the list. A later `click e7` finds it by that
  attribute. Because each invocation is a fresh process, **re-snapshot after any
  action that changes the DOM** — refs from an old snapshot go stale, exactly
  like Playwright refs.
- **Clicks/fills are JS-dispatched** (`element.click()`, native value setter +
  `input`/`change` events). This works on background tabs, which native CDP
  mouse events do not reliably reach in headed Chrome. Trade-off: dispatched
  events are not `isTrusted`, so a few hard anti-bot / payment flows may reject
  them (see Gotchas).

## Setup (per machine)

```bash
npm install -g @generativereality/browser-automation
browser-automation launch     # start the canonical Chrome on :9223 (idempotent)
browser-automation doctor     # verify Node, Chrome, targets, sessions
```

`launch` is idempotent — safe to call when Chrome is already up. Override the
profile path with `BROWSER_AUTOMATION_PROFILE=...` and the CDP host with
`BROWSER_AUTOMATION_CDP=http://localhost:PORT` if needed.

## Commands

Page commands take a tab selector — `-s <session>` (default `$BAC_SESSION`, else
`default`), `-m <url/title substr>`, or `-t <targetId>`.

| Need | Command |
|---|---|
| Start/refresh the Chrome | `browser-automation launch` |
| Diagnose setup | `browser-automation doctor` |
| List sessions + every open tab (id, title, url) | `browser-automation list` |
| Open a background tab | `browser-automation new -s work [url]` |
| Navigate (session tab created if needed) | `browser-automation goto -s work https://example.com` |
| Drive a tab the user already opened | `browser-automation snapshot -m nordnet` |
| Adopt an open tab into a session | `browser-automation bind -s bank -m nordnet` |
| List interactive elements (refs) | `browser-automation snapshot -m op.fi` |
| Click by ref | `browser-automation click -m op.fi e7` |
| Type into a field by ref | `browser-automation fill -s work e3 "value" [--submit]` |
| Read page text (or a selector) | `browser-automation read -m op.fi ['.balance']` |
| Evaluate JS in the tab (escape hatch) | `browser-automation eval -m op.fi 'document.title'` |
| Download a file / CSV export | `browser-automation download -m bank --click e42` (or `--url <href>`) |
| Inspect network (find the API, headers, bodies) | `browser-automation network -m bank --reload --filter api --headers --body` |
| Screenshot a tab | `browser-automation screenshot -m op.fi --full -o shot.png` |
| Forget a session (tab stays open) | `browser-automation close -s work` |
| Forget **and** close the browser tab | `browser-automation close -s work --tab` |

Typical loop:

```bash
browser-automation goto -s work https://app.example.com/login
browser-automation snapshot -s work          # -> e1 input, e2 input, e3 button …
browser-automation fill -s work e1 "user@example.com"
browser-automation fill -s work e2 "secret" --submit
browser-automation snapshot -s work          # re-snapshot: DOM changed after submit
browser-automation read -s work '.account-balance'
```

## Parallel sessions — one per Claude Code tab

Give each session a distinct `-s` name and they never interfere. Either pass
`-s` every call, or set it once for the shell:

```bash
export BAC_SESSION="$(basename "$PWD")"   # every command in this shell uses it
browser-automation goto https://app.example.com
```

Each session drives its own background tab in the same Chrome. No shared
connection, no id collisions, no active-tab fighting — that's the whole point of
the per-target model.

## Auth-persistence — log in once, reuse forever

The persistent profile carries cookies and extensions, so for most sites you log
in once (interactively, in the headed window) and every later run just works:

```bash
browser-automation goto -s cf https://dash.cloudflare.com
# user completes login in the Chrome window; cookies land in the profile
browser-automation read -s cf                 # later runs: already authenticated
```

There's no `state-save`/`state-load` to manage — the profile *is* the auth store.

## Gotchas

- **Refs go stale after any DOM change**, not just navigation. Snapshot → use
  those refs for one action → re-snapshot. "ref not found" means re-snapshot.
- **`isTrusted` / synthetic events.** Clicks and fills are JS-dispatched, so a
  small number of hard anti-bot or payment widgets that demand trusted events
  may ignore them. For those, escalate to a foregrounded native-input path
  (future `--native` flag) or have the user do that one step manually.
- **Cross-origin iframes are separate CDP targets.** `read`/`snapshot` see the
  page's own document and same-origin frames, not cross-origin iframes (common
  for SSO bank login widgets and embedded captchas). If the content you need
  lives in a cross-origin iframe, it has its own `webSocketDebuggerUrl` — the
  per-page CDP escape hatch below can read it directly.
- **Downloads.** `download` arms the CDP browser download API and waits for
  completion, then reports the saved path (default `~/.browser-automation/downloads/`).
  Trigger it with `--click <ref>` on the export link/button, or `--url <href>`
  for a direct CSV endpoint (e.g. OP's `a[href*=csv.do]`). **Caveat:** a button
  whose JS handler builds a client-side **blob** and clicks it via a *nested*
  synthetic click won't fire (Chrome activation quirk) — for those, grab the
  underlying export URL/endpoint and use `--url`, or the site's API.
- **Page still loading.** `goto` waits for the load event, but SPAs render after.
  If a `read`/`snapshot` looks empty, re-run after a moment, or snapshot again
  once a known element should be present.
- **`launch` is macOS/Linux only** (resolves the Chrome binary per-OS). On other
  setups, start Chrome manually with `--remote-debugging-port=9223
  --user-data-dir="<profile>"`.

## Network insights — find the API behind a page

`network` captures requests during a window (and an optional trigger), so you
can discover the JSON API a dashboard calls, capture the auth headers it uses,
and read response bodies — then scrape via that API instead of the DOM (more
robust). Triggers: `--reload`, `--click <ref>`, `--nav <url>`, or passive.

```bash
browser-automation network -m bank --reload --filter api --headers --body
browser-automation network -m app --click e12 --filter graphql --body
```

`--headers` surfaces `authorization` / `cookie` / `x-*` / `content-type` (e.g.
Revolut's `x-registered-identity` / `x-device-id` for statement replay).
**Caveat:** `--reload` on a *bank* tab can re-trigger its login challenge — for
banks prefer a `--click` on an in-app element that fetches data, not a reload.

## Escape hatch — raw per-page CDP for pure scraping

When you just need to read a value out of a specific tab (no clicks), a raw
WebSocket to that tab's `webSocketDebuggerUrl` + `Runtime.evaluate` is the most
robust thing possible — it's exactly what this CLI does internally, and it works
even on tabs the CLI doesn't own. `browser-automation read` covers the common
case; drop to raw CDP only for cross-origin-iframe reads or one-off probes.

## Hit a shortcoming or bug? Fix it — it's open source

This CLI is `@generativereality/browser-automation` (repo:
`github.com/generativereality/browser-automation`). When you hit a missing
capability or a bug (a site needs something the CLI can't do yet, an export
won't trigger, a selector strategy fails), **fix it at the source rather than
working around it forever**:

1. **Clone** next to your work: `gh repo clone generativereality/browser-automation`
   (or `git clone https://github.com/generativereality/browser-automation`).
2. **Fix** in `src/` — TypeScript. Commands live in `src/commands/<name>.ts`,
   the daemonless CDP core in `src/core/` (`cdp.ts` connection/eval/navigate,
   `dom.ts` injected snapshot/click/read JS, `download.ts`, `resolve.ts` tab
   selection). Add a command by creating `src/commands/x.ts` and registering it
   in `src/commands/index.ts`.
3. **Validate locally** against the running Chrome:
   `npm install && npm run typecheck && npm run build`, then `npm link` (so the
   global `browser-automation` points at your build) — or run `node dist/index.js …`.
   Reproduce the failure, confirm the fix, and re-test on a scratch tab you
   created (read-only-safe; never disrupt the user's live tabs).
4. **Propose a PR** for the user to review and contribute upstream — don't
   publish yourself (the maintainer cuts releases):
   ```bash
   git checkout -b fix/<short-desc>
   git commit -am "fix: <what and why>"
   gh pr create --fill --repo generativereality/browser-automation
   ```
   Then tell the user the branch/PR link and what it changes, and ask them to
   review and merge. After it's released, `npm install -g @generativereality/browser-automation@latest`.

## Troubleshooting

- **`No CDP browser on http://localhost:9223`** → `browser-automation launch`.
- **`command not found: browser-automation`** → `npm install -g @generativereality/browser-automation`.
- **Chrome was restarted** → nothing to do; the next `goto` recreates the
  session's tab automatically (sessions self-heal; `list` shows `stale`).
- **A login wall on a repeat run** → the profile lost cookies (rare) or the site
  logged you out; just log in again in the headed window.
- **CAPTCHA / bot challenge** → expected on heavily-protected sites; pause for the
  user, or fall back to a vendor API/CLI if one exists.
