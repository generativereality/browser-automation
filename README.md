# browser-automation

A daemonless, per-tab-isolated browser automation CLI for AI agents (built for
Claude Code, usable anywhere). It drives **one shared headed Chrome** with a
**persistent profile** — cookies and browser extensions (password managers, etc.)
survive across runs — over **per-target Chrome DevTools Protocol**.

No MCP server, no daemon, **nothing long-lived to crash**. Every command is a
fresh process that connects to a single tab, acts, and exits.

## Why

Driving a shared Chrome the usual way (Playwright's `connectOverCDP`, or an MCP
server holding a browser object) has three recurring failures:

1. **It wedges.** `connectOverCDP` enumerates *every* target on connect; one
   stuck iframe/worker or a pile of open tabs hangs the whole handshake.
2. **It can't run in parallel.** All sessions share one "active tab"; concurrent
   agents fight over it and steal each other's (and the user's) focus.
3. **The process dies.** When an MCP server's connection drops or Chrome
   restarts, the client needs a reconnect/restart.

This CLI fixes all three by talking **per-target CDP** and keeping **no
long-lived process**:

- Each command connects to one tab's `webSocketDebuggerUrl` — no whole-browser
  enumeration, so target count never wedges it.
- Each session owns one tab by name (`-s <name>`); commands only touch that tab.
  New tabs open in the background and the CLI never activates/foregrounds a tab,
  so parallel sessions and the user never collide.
- Nothing persists but the user's Chrome and a tiny per-session file. Chrome
  restarts? The next `goto` recreates the tab (sessions self-heal).

## Install

```bash
npm install -g @generativereality/browser-automation
browser-automation launch     # start the canonical Chrome on :9223 (idempotent)
browser-automation doctor     # verify
```

Claude Code skill (so the agent knows how to use it):

```bash
mkdir -p .claude/skills/browser
curl -fsSL https://raw.githubusercontent.com/generativereality/browser-automation/main/skills/browser/SKILL.md \
  -o .claude/skills/browser/SKILL.md
```

…or install the plugin from the marketplace:

```bash
/plugin marketplace add generativereality/plugins
/plugin install browser-automation@generativereality
```

## Usage

Page commands pick a tab with a selector (precedence `-t` > `-m` > `-s`):

- `-m <substr>` — any open tab whose **URL or title** contains the substring
  (errors if ambiguous; `--first` to take the first). Drives tabs the user or
  another flow already opened — no setup.
- `-t <targetId>` — an exact tab (from `list`).
- `-s <name>` — a saved **session** bookmark (default `$BAC_SESSION`, else `default`).

Sessions are optional bookmarks, not locks — there's no one-session-one-tab rule.

```bash
# Session workflow (creates + remembers a tab)
browser-automation goto -s work https://app.example.com/login
browser-automation snapshot -s work          # -> e1, e2, e3 … refs
browser-automation fill -s work e1 "user@example.com"
browser-automation fill -s work e2 "secret" --submit
browser-automation snapshot -s work          # re-snapshot after the DOM changes
browser-automation read -s work '.account-balance'

# Drive a tab that's already open — by URL/title substring, no session needed
browser-automation list                       # see every tab: id, title, url
browser-automation read -m nordnet '.balance'
browser-automation bind -s bank -m nordnet    # …or adopt it into a session
```

| Command | What it does |
|---|---|
| `launch [--status]` | Start the canonical headed Chrome on :9223 (idempotent) |
| `doctor` | Diagnose Node, Chrome, targets, sessions |
| `list` | List sessions and every open tab (id, title, url) |
| `new -s <s> [url]` | Open a background tab for a session |
| `goto (-s\|-m\|-t) <url>` | Navigate (session tab created if needed) |
| `bind -s <name> (-m\|-t)` | Adopt an already-open tab into a session |
| `snapshot (-s\|-m\|-t)` | List interactive elements with refs (`e1`, `e2`, …) |
| `click (-s\|-m\|-t) <ref>` | Click an element by ref |
| `fill (-s\|-m\|-t) <ref> <value> [--submit]` | Type into a field by ref |
| `read (-s\|-m\|-t) [selector]` | Print page text (or a CSS selector's text) |
| `eval (-s\|-m\|-t) <js>` | Evaluate a JS expression in the tab (escape hatch) |
| `download (-s\|-m\|-t) (--click <ref>\|--url <href>)` | Capture a file/CSV download, wait for completion, print the path |
| `close (-s\|-m\|-t) [--tab]` | Forget the session (tab stays open); `--tab` also closes the browser tab |

## How refs work

`snapshot` stamps `data-ba-ref="eN"` onto each interactive element and prints the
list. Because each invocation is a separate process with no shared memory, the
ref table can't live in the CLI — it lives in the page. `click e7` just does
`querySelector('[data-ba-ref="e7"]')`. **Re-snapshot after any DOM change**, the
same one-action-per-snapshot rule as Playwright refs.

## Notes & limits

- Interactions are **JS-dispatched** (`element.click()`, native value setter +
  `input`/`change`), which works on background tabs (native CDP mouse events do
  not reliably reach a non-foreground tab in headed Chrome). Synthetic events are
  not `isTrusted`, so a few hard anti-bot/payment flows may reject them.
- `read`/`snapshot` see the page + same-origin frames, not cross-origin iframes
  (each is its own CDP target).
- `launch` resolves Chrome on macOS/Linux; elsewhere start Chrome manually with
  `--remote-debugging-port=9223 --user-data-dir="<profile>"`.

## Environment

- `BROWSER_AUTOMATION_CDP` — CDP host (default `http://localhost:9223`).
- `BROWSER_AUTOMATION_PROFILE` — Chrome profile dir for `launch`.
- `BAC_SESSION` — default session name for page commands.

## License

MIT
