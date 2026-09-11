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
**renderer** (see Gotchas). Older CLIs printed `nothing to do.` in exactly that
state — **if your `launch` ends without a `Renderer capacity:` line, you are on
one of those; run `doctor`, which is the same probe.** Override the profile path
with `BROWSER_AUTOMATION_PROFILE=...` and the CDP host with
`BROWSER_AUTOMATION_CDP=http://localhost:PORT` if needed.

## Commands

Page commands take a tab selector — `-s <session>` (default `$BAC_SESSION`, else
`default`), `-m <url/title substr>`, or `-t <targetId>`.

| Need | Command |
|---|---|
| Start the Chrome + verify it can make renderers | `browser-automation launch` |
| Diagnose setup (incl. renderer capacity) | `browser-automation doctor` |
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
  **Do NOT hand-roll a raw-CDP trusted click.** Burned 2026-08-22: wrote a
  bespoke `Input.dispatchMouseEvent` helper for exactly this, and it clicked
  stale coordinates (the panel had animated in) — `--trusted` already solves that
  with the actionability wait. Check `browser-automation click --help` before
  building anything.
  **A form can swallow a dispatched click and submit itself the wrong way.**
  npmjs.com's package-settings forms are the case (2026-08-22): a default click
  on the submit button did not reach the framework's handler, so the browser fell
  through to a plain native POST and the tab was replaced by a raw
  `{"message":"Not Found"}` — no error from the CLI, and nothing saved. It looks
  like the server rejected your data; it did not. `--trusted` submitted the same
  form correctly. On any settings page, verify by reloading and re-reading the
  saved state rather than trusting a click that "worked".
- **WebAuthn / security keys need a genuinely focused, visible tab, and you
  cannot supply the touch.** `navigator.credentials.get()` refuses outright when
  `document.hasFocus()` is false or `visibilityState` is `hidden` — which is the
  normal state while you work in the terminal, since `--trusted` only fronts the
  tab for the instant of the click. The prompt then never opens and the page just
  sits there, so a 2FA step can look like it is waiting for the user when the
  browser has already declined to ask. Measured 2026-08-22 on npm's
  `Use security key` challenge: the form POST returned **200** and the challenge
  was live, but it could only be satisfied once the user brought that Chrome
  window to the front themselves. Check with
  `eval '({f:document.hasFocus(),v:document.visibilityState})'` before concluding
  anything, and hand hardware-2FA steps to the user with the window frontmost.
- **Controlled-form state stickiness.** Form libraries that subscribe to React's
  internal value-setter (React Hook Form, Final Form, Formik with a `Controller`,
  Blocket/finn.no's `recommerce` editor) sometimes ignore the synthetic `input`
  event the default `fill` dispatches: the DOM input shows the new value, but
  the form's React state stays on the old one — and the next submit serializes
  the *old* value. Two ways out:
  1. **`fill --native --verify <ref> <value>`** — drives character insertion
     through CDP `Input.insertText` (trusted events). `--verify` re-reads the
     field afterwards and warns if either the DOM value diverged from what you
     asked for, or if React's internal `_valueTracker` still holds the old
     value (the canonical state-stickiness signature). Use this first; it
     solves the vast majority of cases.
  2. **API bypass** — when even `--native` doesn't stick (e.g. the form library
     binds to an external state machine that drives its own POST/PUT), grab the
     form's underlying endpoint and hit it directly:
     ```bash
     # Hook fetch and persist a real form-submit's body + headers via localStorage
     # (it survives the post-submit navigation, unlike window.* globals):
     browser-automation eval -s app "(function(){var f=window.fetch;window.fetch=function(u,o){if(o&&o.method==='PUT'&&u.toString().includes('/api/item/')){localStorage.setItem('__lastPut',o.body||'');localStorage.setItem('__lastHdrs',JSON.stringify(o.headers||{}));}return f.apply(this,arguments);};})()"
     # …then click Save once in the form so the hook captures the canonical PUT…
     browser-automation eval -s app "({body:localStorage.getItem('__lastPut'),headers:localStorage.getItem('__lastHdrs')})"
     # …gives you the endpoint, exact body shape, and custom headers
     # (e.g. Blocket uses E-Tag, not the standard If-Match — and the etag lives
     # in the JSON body, not the HTTP header).
     ```
     Then re-fetch the GET endpoint for current data + the current etag, PUT
     directly with the modified field(s) and the captured custom header, and
     **drive the form's terminal commit step through the UI** — many two-step
     editors (`edit → delivery → publish`) only persist `state: "edit"`
     server-side until that final Save fires the commit.

  Blocket's recommerce price field is the canonical case: default `fill e43 "500"`
  shows 500 in the input but submits 750. Fix: `fill --native --verify e43 "500"`
  (or, if --native doesn't stick: direct PUT to
  `/recommerce/create/api/item/<id>` with `E-Tag: <body.etag>`, then click
  Save on the delivery page to commit).
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
- **File upload.** Three paths. The first two mirror Playwright. For a static, snapshot-able
  `<input type=file>`, use `setfiles <ref> <path…>` — it resolves the ref and
  calls `DOM.setFileInputFiles` (a file input's `.files` is read-only to page JS,
  so a value-setter/`eval` can't populate it; CDP can, and fires trusted
  `input`/`change`). For a **custom "attach" button** that opens a native file
  chooser and reads a *transient* `<input type=file>` it creates+clicks on the fly
  (App Store Connect's "Attach File", many React dropzones), `setfiles` on the
  static input is useless — the handler uses its own throwaway input. Use
  `upload --click <ref> <path…>`: it arms `Page.setInterceptFileChooserDialog`,
  clicks the trigger, waits for `Page.fileChooserOpened`, and sets files on the
  `backendNodeId` Chrome reports. Paths are resolved from cwd; pass absolute paths
  to be safe. Multiple paths upload as a multi-file selection.
  **Verify by re-snapshot/screenshot, and DON'T blindly retry.** Apps reset the
  input to 0 right after consuming the file, so `upload` judges success by the
  `change` event (it reports "delivered"), not by residual `input.files` — a
  successful upload legitimately leaves `files=0`. The staged file often shows up
  as a row in an attachment *list* (e.g. ASC's "Message Attachments"), not a single
  chip, so confirm with `snapshot`/`screenshot` rather than assuming. Each
  successful run **adds another attachment** — retrying a "did it work?" upload a
  few times silently produces duplicates (this cost us a dozen copies on a live ASC
  reply). Upload once, verify, and only re-run if verification shows nothing staged.
  The **third path is drag-and-drop**, for zones with NO `<input type=file>` at
  all — a `drop` listener reading `e.dataTransfer.files` (vocalremover-style audio
  tools, many image/video drop zones). Neither `setfiles` nor `upload` applies;
  use `drop <ref> <path…>`. By default it fires a genuinely-**trusted** CDP drag
  (`Input.dispatchDragEvent`) carrying the real files from disk: it force-fronts
  the tab (bringToFront + focus emulation + active lifecycle — so the tab reports
  focused+visible even when the Chrome window isn't the frontmost OS window),
  waits for the zone to be actionable, then dragEnter→dragOver→drop. The
  force-front matters: drop-zone uploaders commonly do their work only inside a
  **user activation**, and CDP input grants no activation on a tab the renderer
  considers `hidden` — which it is whenever the window is occluded (the usual
  case while you work in the terminal). vocalremover.org is the canonical example:
  the file reaches its `change`/`drop` handler either way, but it only uploads +
  separates once activation is present. `--js` instead dispatches a synthetic
  (isTrusted=false) `DataTransfer` drop **without** force-fronting/stealing focus,
  for zones that accept synthetic events. The `<ref>` can be any snapshot element
  sitting over the drop region (a heading/button inside the zone) — the drop
  bubbles to the zone/document handler, so it works even when the drop div itself
  isn't snapshot-interactive. After the drop, `read`/`screenshot`/`network` to
  confirm processing started, then grab the result (often a download endpoint you
  can pull with `download --url`).
- **A NEW tab's renderer can be slow rather than broken — do not restart Chrome for it.**
  ⚠️ **Read this before acting on the wedge diagnosis below.** Measured 2026-09-11 on
  Chrome 152.0.7977.83, time from `Target.createTarget` to the first `Runtime.evaluate`
  returning, 8 trials each:

  | how the target was created | median | worst |
  |---|---|---|
  | `background: true` (how this tool opens every tab) | 367ms | 12517ms, and >30s once |
  | `background: true` + `Target.activateTarget` | 19ms | 65ms |
  | `background: false` | 18ms | 22ms |

  The renderer **process exists** in every arm — `ps` gains a `--type=renderer` child either
  way. A background target is simply not given a renderer that answers promptly, and on a
  loaded machine (this one was at load average 38) the tail runs past any budget worth
  waiting. **This is not the wedge**, and a restart does nothing for it.

  It cost real work to learn: for three weeks `goto` reported this as the permanent,
  restart-only condition below, and `launch --restart` closes every tab of every session
  sharing this Chrome. It twice destroyed unrecoverable work belonging to another session —
  a finished AlternativeTo submission with hand edits, and an Azure signup flow mid-form.

  **Since fixed (v0.4.12+):** `new`/`goto` wait for a late renderer and, if it still has not
  answered, briefly activate the tab to force one and hand the window straight back (you get
  a `WARN` saying so). The probe retries with a doubling budget, and the verdict now names
  the permanent failure **only when its own signature is present**. On an older CLI, the
  cheap move is to retry, or to drive a tab that already works.

  **Whatever the version: before restarting anything, check the two corroborations.** Both
  were decisive and neither used to be consulted:
  ```bash
  launchctl print "gui/$(id -u)" | grep MachPortRendezvousServer.<browser-pid>
  ps -Ao command= | grep -c -- '--type=renderer'
  ```
  Mach name **present** + renderers **alive** ⇒ this is slowness, not the wedge. Retry, or use
  a live tab. Mach name **absent** ⇒ it is the wedge, and only then is a restart the answer.

- **"The site is blocking us" — when it is really Chrome that cannot make renderers.**
  A browser process can permanently lose the ability to launch **renderer processes** while
  looking perfectly healthy. Every tab that already exists keeps working, so nothing seems wrong
  until you open a tab or navigate somewhere new, and then the errors read as the remote site's
  doing. Diagnosed 2026-08-22; it cost an hour of blaming ferry-operator bot protection.
  ⚠️ **This is a real condition and a rare one.** Confirm the Mach name is absent (above)
  before you believe it — a slow background renderer produces every symptom in this list.

  How it shows up:
  - `browser-automation new` + `goto` → `CDP Page.enable timed out after 30000ms`, **even for
    `example.com`**.
  - **Cross-origin** navigation of an existing, working tab → `navigate failed: net::ERR_ABORTED`.
    Site isolation puts a new origin in a new renderer — the exact thing Chrome can no longer do.
  - **Same-origin** navigation on that same tab keeps working perfectly (Skyscanner → Skyscanner
    with new query params was fine throughout). That asymmetry is what makes it masquerade as
    "only site X blocks us": the tab you were already using still behaves.
  - A target created at the browser level (`PUT /json/new?<url>`) appears in `/json/list` with the
    right URL but an **empty title forever**; every `Runtime.evaluate` against it times out.
    `Page.captureScreenshot` returns `Internal error`. The target shell exists; the renderer does not.

  **It gets SLOW before it fails outright — that is the early warning.** Observed 2026-09-07 on a
  Chrome that had been up 12 days: every `goto` took ~25–30s, and a batch of three blew a 120s
  timeout, hours before anything failed hard. That was misread as "large files, slow browser" and
  worked around with longer timeouts for many minutes; the actual fix was one `launch --restart`,
  after which the same pages loaded instantly and 14 `file://` tabs opened in two quick batches.
  **A `goto` that has quietly become slow is this, not your page.** Raise the timeout at most once,
  then run `doctor`.

  **Every cheap signal stays green, so do not take any of them as health.** On that same wedged
  browser: `launch` said `Already running on :9223 — nothing to do.`, `curl :9223/json/version`
  answered normally, and `list` cheerfully returned 10 targets — while `goto` exited 1 and `eval`
  died with `CDP Runtime.evaluate timed out after 30000ms`. Port held, HTTP endpoint answering and
  targets listed are all properties of the **browser** process; the thing that is broken is its
  ability to start a **renderer**, and only a probe that runs code in one can see it.
  **Since fixed:** `launch` now runs that probe itself and exits non-zero with the diagnosis
  instead of reporting "nothing to do", so this particular green-across-the-board trap is closed.
  It still will not restart for you — that stays something you type, because the tabs are not
  only yours. On a CLI old enough to lack it, `doctor` is the same probe; nothing cheaper
  substitutes for either.

  **The mechanism** (macOS, from Chrome's own log at `$TMPDIR/chrome-<port>.log` — `launch --restart`
  keeps the previous browser's log as `chrome-<port>.log.prev`, which is the one you want after a
  restart):
  ```
  ERROR:base/apple/mach_port_rendezvous_mac.cc:256]
    bootstrap_look_up com.google.Chrome.MachPortRendezvousServer.<pid>: (ipc/send) invalid destination port
  ERROR:base/memory/shared_memory_switch.cc:261]
    No rendezvous client, terminating process (parent died?)
  ```
  A Chrome child process gets its shared-memory handles by looking up a Mach bootstrap service the
  browser registers **once, at startup**, named `com.google.Chrome.MachPortRendezvousServer.<browser-pid>`.
  That registration had vanished from the user's launchd namespace — confirmed absent via
  `launchctl print gui/$UID | grep MachPortRendezvousServer.<pid>`, while two healthy Chromes on the
  same machine were both listed. From then on **every renderer Chrome launches kills itself within
  milliseconds**, which is why none ever appears in `ps` and why the browser only reports
  `Render process gone.` **What made the name vanish is not established.** Two things
  correlated and neither is proven: the binary on disk had moved to 151.0.7922.170 while the live
  browser was still running .138, and `GoogleUpdater` was FATAL-ing on its own `bootstrap_check_in`
  with error 141. But the first renderer failure (18:53) *preceded* the first updater FATAL (19:42)
  by ~50 minutes, so the update churn is at best a fellow symptom of a sick launchd bootstrap
  namespace, not the cause. Treat the trigger as unknown; the diagnosis and the recovery do not
  depend on it.

  **It is NOT about how many tabs are open.** That was the first theory and it is wrong: a freshly
  launched Chrome on the same machine was driven to **421 page targets / 435 live renderer
  processes, every one responsive**, and a 256-fd `ulimit` made no difference either (205 renderers,
  all fine). The broken browser had 66 tabs. The count was a coincidence — so do not treat a big
  tab count as evidence of this, and do not expect closing tabs to fix it.

  **Diagnose it:**
  ```bash
  browser-automation doctor        # measures renderer capacity, not just reachability
  ```
  `doctor` now creates a throwaway tab, makes its renderer evaluate `1+1`, and closes it — the one
  round-trip that separates a wedged browser from a slow network or a hostile site. On failure it
  names the root cause (including the missing bootstrap service and the pid) and points at Chrome's
  log. On a healthy browser it reports e.g. `✓ Renderer capacity: a new tab got a live renderer in
  73ms`. `goto` and `new` run the same probe automatically **on the error path only**, so a bare
  `Page.enable timed out` now arrives with the diagnosis attached instead of sending you to the
  site's bot-protection docs.

  **Recovery — cheapest first, and a restart only once the Mach name is confirmed absent.**

  1. **Retry.** A new tab's renderer has been measured taking 12s and more on a loaded
     machine, and late is not broken.
  2. **Drive a tab that already works.** An existing tab navigates same-origin without
     needing a new renderer, so it keeps working throughout even during a genuine wedge:
     ```bash
     browser-automation list
     browser-automation eval -t <id> "location.href='<url>'"
     ```
  3. **`browser-automation doctor`** — re-measures, prints the two corroborations, and shows
     the recent probe-time distribution from `~/.browser-automation/renderer-probes.jsonl`.
  4. **Only if `doctor` reports the Mach rendezvous service ABSENT**, restart. The bootstrap
     name is registered at startup and never re-registered, so nothing short of a new browser
     process helps; closing tabs does not, and plain `launch` will not either (idempotent by
     design — it sees a live browser and exits happy):
     ```bash
     browser-automation launch --restart    # SIGTERM (profile flushes cleanly), wait, relaunch
     ```
     It reports how many tabs it is about to close. **Those tabs belong to every parallel
     Claude Code session sharing this Chrome — ask Fred first, never restart unilaterally.**

  **Housekeeping is a different problem** — `browser-automation gc` prunes stale session bookmarks
  (they are never cleaned up otherwise; this machine had accumulated 234, only 5 of them live) and
  closes tabs whose renderer does not answer. Use `--dry` first. `list` now counts stale
  bookmarks instead of printing them (`list --all` to see them) — 105 stale lines above a
  24-tab Chrome is how "there are a hundred tabs open" became the leading theory for a
  renderer failure that has nothing to do with tab count. It is genuinely useful, but it is
  **not** a fix for the wedge above, and it never closes a working tab unless you pass `--orphans`
  — tabs get addressed by `-m` and opened by hand, so "no session claims it" is not evidence that
  nobody wants it.

  **The false lead to resist:** a bare `curl` to a suspicious site may genuinely return a bot wall
  (vikingline.fi serves an Imperva "Pardon Our Interruption" page, HTTP 200), which feels like
  confirmation. It confirms nothing about the browser path — the persistent, cookie-bearing profile
  is a completely different client. Check the browser first: if `doctor` says renderer capacity is
  fine and a boring cross-origin URL loads, *then* start suspecting the site.

- **A backgrounded tab may never paint at all — and `read`/`snapshot` will not tell you.** Distinct
  from "still loading": `document.readyState` reaches `complete`, but the SPA never renders, so
  `read` returns a stale shell (e.g. a bare "Loading") and `snapshot` lists none of the real
  controls. The trap is that this looks exactly like *the page does not have that element*, and you
  will go hunting for a different selector or conclude the flow changed. Measured 2026-09-02 on
  Google's `accounts.google.com/v3/signin/challenge/pwd`: `readyState: "complete"`,
  `body.innerText.length: 202` frozen on the previous step's text, and the password field present in
  the DOM but `offsetParent === null` for as long as the tab stayed backgrounded.
  **Diagnose** before changing your selector:
  ```bash
  browser-automation eval -s x '({ready:document.readyState,vis:document.visibilityState,len:document.body.innerText.length})'
  ```
  `visibilityState: "hidden"` with a **stuck `len`** is this, not a selector problem. Note the
  stuck `len` is the whole tell: `hidden` on its own is the normal, healthy state of every
  backgrounded tab — verified 2026-09-07, a background tab reporting `hidden` returned its real
  painted text — so never read `hidden` alone as a diagnosis.
  **Fix:** front the tab. There is no `activate` command — a `click --trusted` on any harmless
  element (a wrapper `div` from the snapshot works; avoid submit buttons and links) brings the tab
  to front and waits for it to be visible, and the page paints immediately. Same root cause as the
  WebAuthn note above, different symptom: that one refuses, this one silently never renders.

  **Do not confuse this with the renderer wedge above.** Both present to an operator as "the page
  isn't there, but every tool says fine", and the fixes are opposite — one is a per-tab nudge, the
  other closes every tab in the browser. What separates them:

  | | backgrounded tab never paints | Chrome cannot make renderers |
  |---|---|---|
  | `goto` | succeeds, rc=0 (may be slow) | **rc=1**, or `Page.enable timed out` |
  | `eval` | works, returns a result | **`Runtime.evaluate` times out at 30000ms** |
  | scope | that one tab | **every** new tab / cross-origin nav |
  | `doctor` | `✓ Renderer capacity` | names the wedge + pid |
  | fix | `click --trusted` on the tab | `launch --restart` (**ask first**) |

  `eval` is the fast discriminator: if it answers at all, the renderer is alive and you are in the
  painting case. If it times out, stop poking the page and run `doctor`.
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
   `npm install && npm run typecheck && npm run build`, then run your build as
   **`node dist/index.js <cmd>`** from the clone. **Do NOT `npm link`** — it
   repoints the machine-global `browser-automation` bin, so a parallel Claude
   Code session (or the user's main session) would suddenly be running *your*
   work-in-progress clone instead of the installed release. Validate via the
   explicit `node dist/index.js` path instead. Reproduce the failure, confirm
   the fix, and re-test on a scratch tab you created (read-only-safe; never
   disrupt the user's live tabs).
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

- **`No CDP browser on http://localhost:<port>`** → `browser-automation launch`.
  If it says the port is held by ANOTHER user, that is not your Chrome and
  driving it would act in their session — quit Chrome in that account, or set
  `BROWSER_AUTOMATION_PORT`.
- **`command not found: browser-automation`** → `npm install -g @generativereality/browser-automation`.
- **Chrome was restarted** → nothing to do; the next `goto` recreates the
  session's tab automatically (sessions self-heal; `list` shows `stale`).
- **A login wall on a repeat run** → the profile lost cookies (rare) or the site
  logged you out; just log in again in the headed window.
- **CAPTCHA / bot challenge** → expected on heavily-protected sites; pause for the
  user, or fall back to a vendor API/CLI if one exists.
