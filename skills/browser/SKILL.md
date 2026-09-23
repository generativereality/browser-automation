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

- **One shared headed Chrome per USER** on a uid-derived
  `--remote-debugging-port` (`9223` for the first account on the machine) with a
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
- **No focus stealing — unless you ask for it.** New tabs are created in the
  background, and nothing fronts a tab as a side effect of ordinary driving:
  `goto`, `read`, `snapshot`, `fill`, `eval`, `screenshot` all leave your
  frontmost app alone. Three things deliberately do more, and only these:
  `focus` (emulates focus/visibility in the renderer — still **no window
  moves**), `click --trusted` and `drop` (force-front the tab, because CDP input
  grants no user activation to a renderer that considers itself hidden), and
  `focus --raise`, which calls `Target.activateTarget` and **genuinely takes the
  operator's screen**. `--raise` is the only one that does; reach for plain
  `focus` unless a person needs to see the tab.
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
browser-automation launch     # start Chrome, and prove it can still make renderers
browser-automation doctor     # verify Node, Chrome, renderer capacity, targets, sessions
```

`launch` is idempotent — safe to call when Chrome is already up. **It also
verifies the browser works**, which is a different question from whether one is
running: it ends with either

```
✔ Renderer capacity: a new tab got a live renderer in 47ms — this Chrome works.
```

or a non-zero exit and the full renderer-wedge diagnosis. That matters because a
held port, a `/json/version` that answers and a `list` full of targets are all
properties of the browser **process**, and the way a long-lived Chrome dies is
that it keeps all three while losing the ability to give any new tab a
**renderer** (see Gotchas, and [`references/renderer-health.md`](references/renderer-health.md)). Older CLIs printed `nothing to do.` in exactly that
state — **if your `launch` ends without a `Renderer capacity:` line, you are on
one of those; run `doctor`, which is the same probe.** Override the profile path
with `BROWSER_AUTOMATION_PROFILE=...` and the CDP host with
`BROWSER_AUTOMATION_CDP=http://localhost:PORT` if needed.

**The profile lives in `~/.browser-automation/chrome-profile`** (`browser-automation
profile` prints it). Older CLIs kept it inside Chrome's own folder,
`~/Library/Application Support/Google/Chrome/browser-automation`, and `launch` moves
it out the first time it can — logins included; the move is a single rename and
Chrome's cookie key lives in the Keychain, not in the path. To move it on demand:

```bash
browser-automation profile --migrate    # refuses, changing nothing, if a Chrome has it open
browser-automation launch --restart     # quits Chrome first, then moves it and relaunches
```

**Why it moved: macOS decides access to Chrome's folder per HOST app.** A session
started from a terminal that was once allowed reaches it; one started by an app
that was not — Clerk.AI, denied in 2026-08 and silently refused ever since — gets
`EPERM`, and Chrome dies with

```
Failed to create …/browser-automation/SingletonLock: Operation not permitted (1)
Failed to create a ProcessSingleton for your profile directory. … Aborting now
```

**That is not a stale lock**, and there is no lock file to delete. It is also why
the same command works from your terminal and fails from an app. ⛔ **Do not work
around it with a scratch `--user-data-dir` or `BROWSER_AUTOMATION_PROFILE` pointed
at an empty folder**: Chrome starts, and the person is signed out of every site in
the real profile. Run `browser-automation profile --migrate` once from a terminal
that can reach the old folder; every host reaches the new one.

## Commands

Page commands take a tab selector — `-s <session>` (default `$BAC_SESSION`, else
`default`), `-m <url/title substr>`, or `-t <targetId>`.

| Need | Command |
|---|---|
| Start the Chrome + verify it can make renderers | `browser-automation launch` |
| Diagnose setup (incl. renderer capacity) | `browser-automation doctor` |
| Where the Chrome profile lives / move it out of Chrome's folder | `browser-automation profile` / `profile --migrate` |
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
| Set files on a known `<input type=file>` | `browser-automation setfiles -m app e7 ~/Desktop/clip.mp4` |
| Upload via a button that opens a file chooser | `browser-automation upload -m app --click e9 ~/Desktop/clip.mp4` |
| Drop file(s) onto a drag-and-drop zone | `browser-automation drop -m app e7 ~/Desktop/clip.mp4` (add `--js` for a synthetic drop) |
| Inspect network (find the API, headers, bodies) | `browser-automation network -m bank --reload --filter api --headers --body` |
| Screenshot a tab | `browser-automation screenshot -m op.fi --full -o shot.png` |
| Make a hidden tab render (charts, video, polling) | `browser-automation focus -s work` (add `--raise` to really front it) |
| Prune stale session bookmarks + dead tabs | `browser-automation gc --dry` (then without `--dry`) |
| Restart Chrome (LAST resort — closes ALL tabs, for EVERY session; only once `doctor` confirms the Mach name is absent) | `browser-automation launch --restart` |
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

- **Values may contain `--` freely.** `fill -s work e3 "see the --native flag"`
  and a whole markdown brief with `---` rules go through as one quoted argv
  element. Only a value that *begins* with a dash and is option-shaped
  (`--force`, `-5`) needs the POSIX separator: `fill -s work -- e3 "--force"`.
  An error naming the element (`'--force' is not an option of 'fill'`)
  means exactly that — add `--`, do not re-quote.
- **Refs go stale after any DOM change**, not just navigation. Snapshot → use
  those refs for one action → re-snapshot. "ref not found" means re-snapshot.
- **`isTrusted` / synthetic events.** Clicks and fills are JS-dispatched by
  default, so widgets that demand trusted events ignore them. **For clicks, pass
  `--trusted`** — it dispatches a real CDP `Input.dispatchMouseEvent`, brings the
  tab to front, waits for it to be focused+visible (CDP input no-ops on a
  backgrounded tab) and waits for the element to be actionable (stable position +
  unoccluded hit-test) before pressing. For fills, pass `--native` to drive
  character insertion through CDP `Input.insertText`, which fires real
  `beforeinput`/`input` events.
  **Reach for `--trusted` the moment a click "succeeds" but nothing happens** —
  the CLI prints `✔ clicked e7` on a dispatched event regardless of whether the
  widget reacted, so a silent no-op is the signature, not an error. Canonical
  cases: LinkedIn artdeco dropdown items, Radix dropdowns/popovers, cmdk
  comboboxes, and **framework-state form widgets whose inputs are `readonly` with
  no `name`** (Viking Line's booking selectors — the visible fields are display
  shells; the real state lives in the framework, so `fill` and DOM value-setting
  do nothing at all).
- **There is NO way to send real keystrokes, and `fill --native` is not one** — it never fires
  `keydown`, so a combobox that filters on keystrokes stays empty. ⛔ **Do not hand-roll a
  raw-CDP trusted click** — `--trusted` already waits for actionability; check
  `browser-automation click --help` before building anything. A form can also swallow a
  dispatched click and fall through to a native POST (a raw `{"message":"Not Found"}` page,
  nothing saved): use `--trusted`, and on any settings page verify by reloading and re-reading.
  → The raw-CDP `Input.dispatchKeyEvent` recipe and its two traps are in
  [`references/input-and-forms.md`](references/input-and-forms.md).
- **WebAuthn / security keys need a genuinely focused, visible tab, and you cannot supply the
  touch.** The prompt silently never opens on a backgrounded tab. Check
  `eval '({f:document.hasFocus(),v:document.visibilityState})'` and hand hardware-2FA steps to
  the user with the window frontmost. Detail: [`references/input-and-forms.md`](references/input-and-forms.md).
- **Controlled-form state stickiness.** The input shows the new value but the submit sends the
  old one (React Hook Form, Formik, Blocket's price field). Use **`fill --native --verify`**
  first; if even that does not stick, bypass to the form's API — the fetch-hook recipe is in
  [`references/input-and-forms.md`](references/input-and-forms.md).
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
- **File upload — three paths:** `setfiles [ref] [path…]` for a static `<input type=file>`;
  `upload --click [ref] [path…]` for a button that opens a native file chooser; `drop [ref]
  [path…]` for a drag-and-drop zone with no file input (`--js` for a synthetic drop that does
  not front the tab). ⛔ **Upload once, verify by `snapshot`/`screenshot`, and don't blindly
  retry** — each successful run adds another attachment, and apps reset `files` to 0 after
  consuming it. How each path works and when to pick it:
  [`references/input-and-forms.md`](references/input-and-forms.md).
- **A NEW tab's renderer can be slow rather than broken — do not restart Chrome for it.**
  ⛔ `launch --restart` closes **every tab of every session** sharing this Chrome (it has
  destroyed other sessions' unrecoverable work). Retry, or drive a tab that already works.
  Restart **only** once `doctor` reports the Mach rendezvous service **absent**, and **ask Fred
  first — never restart unilaterally**.
- **"The site is blocking us" may really be Chrome unable to make renderers** — `Page.enable
  timed out` even for `example.com`, cross-origin `net::ERR_ABORTED`, a `goto` that quietly
  became slow, while `launch`, `/json/version` and `list` all look healthy. Run `doctor`
  before blaming the site.
- **A backgrounded tab may never paint, and `read`/`snapshot` will not tell you** — it looks
  like the page lacks the element. Diagnose before changing selectors:
  `eval '({ready:document.readyState,vis:document.visibilityState,len:document.body.innerText.length})'`.
  `hidden` with a stuck `len` ⇒ run `focus` on the tab (`hidden` alone is normal). If `eval`
  itself times out, it is the renderer wedge instead: run `doctor`.
- → **Read [`references/renderer-health.md`](references/renderer-health.md)** whenever
  `new`/`goto`/`eval` time out or turn slow, a site seems to block you, a page reads as a
  frozen shell, or a restart is on the table. It has the measurements, the two corroborating
  checks, the wedge mechanism, the recovery order, and the never-paints-vs-wedge table.
- **Page still loading.** `goto` waits for the load event, but SPAs render after.
  If a `read`/`snapshot` looks empty, re-run after a moment, or snapshot again
  once a known element should be present.
- **`launch` is macOS/Linux only** (resolves the Chrome binary per-OS). On other
  setups, start Chrome manually with `--remote-debugging-port=<doctor's port>
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

This CLI is `@generativereality/browser-automation`
(`github.com/generativereality/browser-automation`). When a site needs something the CLI
can't do, or it misbehaves, **fix it at the source rather than working around it forever**.
⛔ **Never `npm link`** a clone (it hijacks the machine-global bin for every parallel
session), and never publish yourself — propose a PR for the user. How to clone, where the
code lives, how to validate with `node dist/index.js`, and the PR steps:
[`references/contributing.md`](references/contributing.md).

## Troubleshooting

- **`No CDP browser on http://localhost:<port>`** → `browser-automation launch`.
  If it says the port is held by ANOTHER user, that is not your Chrome and
  driving it would act in their session — quit Chrome in that account, or set
  `BROWSER_AUTOMATION_PORT`.
- **`SingletonLock: Operation not permitted` / "Failed to create a ProcessSingleton"**
  → macOS refused the app this session runs under access to **Chrome's** folder,
  where old CLIs kept the profile (see Setup). Not a stale lock; do not delete
  anything. Upgrade the CLI (`npm install -g @generativereality/browser-automation@latest`)
  and `launch` again: current versions start Chrome through `open(1)`, under
  Chrome's own identity, so it opens its folder whatever app you run under, and
  they move the profile to `~/.browser-automation/` when they can.

  **What to tell the person — and what NOT to.** ⛔ **Do not ask them to grant
  Full Disk Access** (to the app, to the terminal, to anything). It does work, and
  it hands that app every file on the Mac to fix a problem that needs none of it:
  an agent in Mind My Money said exactly that on 2026-09 — *"let Mind My Money
  reach that folder. Full Disk Access does it, but it also opens far more than
  Chrome"* — when the real fix was a CLI upgrade. Also do not suggest a fresh
  profile or `BROWSER_AUTOMATION_PROFILE` pointed at an empty folder: that signs
  them out of every bank and portal. If `launch` still reports `Profile not moved`
  after upgrading, the browser works anyway (the old folder is still used); the
  one-time move needs a host macOS allows into Chrome's folder, so the ask is small
  and exact: *open Terminal and run `browser-automation profile --migrate`; if macOS
  asks whether Terminal may access data from other apps, allow it.*
- **`command not found: browser-automation`** → `npm install -g @generativereality/browser-automation`.
- **Chrome was restarted** → nothing to do; the next `goto` recreates the
  session's tab automatically (sessions self-heal; `list` shows `stale`).
- **A login wall on a repeat run** → the profile lost cookies (rare) or the site
  logged you out; just log in again in the headed window.
- **CAPTCHA / bot challenge** → expected on heavily-protected sites; pause for the
  user, or fall back to a vendor API/CLI if one exists.
