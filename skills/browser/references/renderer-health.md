# Renderer health — slow tabs, wedged Chrome, tabs that never paint

Reference for the `browser` skill. Read it when `new`/`goto` time out or are suddenly slow,
`eval` times out, a site seems to "block" you, `doctor` reports a renderer problem, a page
reads as a frozen shell, or before you even consider `launch --restart`. The hard rules are
in `SKILL.md`, under Gotchas; this is the evidence, the diagnosis and the recovery order.

- **A NEW tab's renderer can be slow rather than broken — do not restart Chrome for it.**
  ⚠️ **Read this before acting on the wedge diagnosis in the next item.** Measured 2026-09-11 on
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
     browser-automation launch --restart    # quit (CDP, then SIGTERM), wait for the profile, relaunch
     ```
     It reports how many tabs it is about to close. `Chrome released its profile but left its
     process running (normal on macOS); ending it.` is the **expected** line, not a fault: on
     macOS 27 / Chrome 153 the browser process never exits on its own after quitting, but it
     does flush and release the profile first, and that release is what the restart waits for.
     (Older CLIs waited only for the port to close and relaunched on top of the still-running
     Chrome — two browsers on one profile. If you see `Chrome did not exit on SIGTERM`, or no
     such line and then odd profile errors, you are on one of those.) **Those tabs belong to every parallel
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
  **Fix:** make the tab report itself visible.
  ```bash
  browser-automation focus -s x        # quiet: no window moves, you keep your frontmost app
  ```
  `focus` emulates focus + visibility in the renderer, then **reads back what it actually
  achieved** rather than reporting that it sent the command — so a partial result says which half
  is missing instead of printing a tick over it. The page paints immediately. Add `--raise` only
  when a *person* needs to see the tab: that genuinely fronts it and **takes the operator's
  screen**, which is exactly what you normally want to avoid.
  Same root cause as the WebAuthn note in [`input-and-forms.md`](input-and-forms.md), different symptom: that one refuses, this one
  silently never renders.
  *(Older CLIs had no `focus`; the workaround was a `click --trusted` on a harmless wrapper `div`,
  which fronted the tab as a side effect of needing trusted input. Prefer `focus` — it says what it
  achieved, and it does not click anything.)*

  **Do not confuse this with the renderer wedge (previous item).** Both present to an operator as "the page
  isn't there, but every tool says fine", and the fixes are opposite — one is a per-tab nudge, the
  other closes every tab in the browser. What separates them:

  | | backgrounded tab never paints | Chrome cannot make renderers |
  |---|---|---|
  | `goto` | succeeds, rc=0 (may be slow) | **rc=1**, or `Page.enable timed out` |
  | `eval` | works, returns a result | **`Runtime.evaluate` times out at 30000ms** |
  | scope | that one tab | **every** new tab / cross-origin nav |
  | `doctor` | `✓ Renderer capacity` | names the wedge + pid |
  | fix | `focus` on the tab | `launch --restart` (**ask first**) |

  `eval` is the fast discriminator: if it answers at all, the renderer is alive and you are in the
  painting case. If it times out, stop poking the page and run `doctor`.
