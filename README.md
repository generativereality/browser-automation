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

A fourth selector, `-F <substr>`, is orthogonal — it descends **into** a tab,
to a **cross-origin child iframe** (OOPIF) whose URL/title contains the
substring (e.g. `-F js.stripe.com` to fill Stripe Elements). OOPIFs are
first-class CDP targets, so every page command (`snapshot`/`click`/`fill`/
`read`/`eval`) works inside them. Same-origin iframes aren't separate targets —
they're already reachable from the parent page, no `-F`. Discover frames with
`list --frames`; an ambiguous `-F` errors (narrow it, use `-t <iframeTargetId>`,
or `--first`).

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
| `setfiles (-s\|-m\|-t) <ref> <path…>` | Set files on a known `<input type=file>` by ref (fires input/change) |
| `upload (-s\|-m\|-t) --click <ref> <path…>` | Upload via a button that opens a file chooser (transient/custom inputs) |
| `drop (-s\|-m\|-t) [--js] <ref> <path…>` | Drop file(s) onto a drag-and-drop zone by ref (trusted CDP drag by default; `--js` for a synthetic drop) |
| `network (-s\|-m\|-t) [--reload\|--click\|--nav] [--filter --headers --body]` | Capture network requests (find the API, headers, response bodies) |
| `screenshot (-s\|-m\|-t) [--full] [-o path]` | Save a PNG screenshot (viewport or full page) |
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
- `read`/`snapshot` see the page + same-origin frames. A **cross-origin iframe**
  is its own CDP target — reach it with `-F <substr>` (or `-t <iframeTargetId>`
  from `list --frames`); every page command then runs inside that frame.
- **File upload** has two entry points (Playwright's two paths). For a static
  `<input type=file>` you can snapshot, use `setfiles <ref> <path…>`. For a custom
  "attach" button that opens a native file chooser — and reads a *transient* input
  that only exists during the chooser (App Store Connect's "Attach File", many
  React dropzones) — use `upload --click <ref> <path…>`: it intercepts the chooser
  and sets files on whatever input Chrome opens. Setting the static input via JS
  won't work there; the button uses its own throwaway input. `upload` judges
  success by the `change` event (reports "delivered"), since apps reset the input
  to 0 after consuming the file — so `files=0` afterward is normal. **Verify by
  re-snapshot/screenshot and don't blindly retry:** the file may stage as a row in
  an attachment *list* (not a single chip), and each successful run adds another
  attachment, so retrying can silently create duplicates.
- **Drag-and-drop upload** is a third path, for zones with no `<input type=file>`
  at all — a `drop` listener reading `e.dataTransfer.files` (vocalremover-style
  audio tools, many image/video drop zones). `drop <ref> <path…>` fires a
  genuinely-**trusted** CDP drag (`Input.dispatchDragEvent`) carrying the real
  files from disk: it force-fronts the tab (bringToFront + focus emulation +
  active lifecycle, so the renderer reports focused+visible even when the Chrome
  window is occluded), waits for the zone to be actionable, then
  dragEnter→dragOver→drop — same discipline as `click --trusted`. The force-front
  matters because drop-zone uploaders often act only inside a **user activation**,
  which CDP input can't grant on a tab the renderer considers `hidden`
  (vocalremover.org is the canonical case). `--js` instead dispatches a synthetic
  (isTrusted=false) `DataTransfer` drop without force-fronting/stealing focus, for
  zones that accept synthetic events. The `<ref>` is any snapshot element over the
  drop region — the drop bubbles to the zone/document handler, so a heading or
  button inside the zone works even when the zone div itself isn't
  snapshot-interactive. After dropping, confirm with `read`/`screenshot` and pull
  the result (often a `download --url` endpoint).
- `launch` resolves Chrome on macOS/Linux; elsewhere start Chrome manually with
  `--remote-debugging-port=9223 --user-data-dir="<profile>"`.

## Environment

- `BROWSER_AUTOMATION_CDP` — CDP host (default `http://localhost:9223`).
- `BROWSER_AUTOMATION_PROFILE` — Chrome profile dir for `launch`.
- `BAC_SESSION` — default session name for page commands.

## License

MIT
