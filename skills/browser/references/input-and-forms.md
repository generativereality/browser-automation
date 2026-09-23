# Input, forms and uploads — the hard cases

Reference for the `browser` skill. Read it when a click or fill "succeeds" but nothing
happens, a combobox needs real keystrokes, a hardware-2FA prompt never appears, a form
submits a stale value, or you need to upload a file. The short rules are in `SKILL.md`,
under Gotchas; this is the detail and the worked cases behind them.

## Keystrokes, and forms that swallow a dispatched click

- **There is NO way to send real keystrokes, and `fill --native` is not one.** `--native` uses CDP
  `Input.insertText`, which fires `beforeinput`/`input` but **never `keydown`**. A combobox that
  filters its list on keystrokes therefore stays empty: the value lands in the DOM and no options
  ever render. npm’s "Select packages and scopes" picker is the canonical case (2026-08-22) — the
  field showed `generativereality` and the list stayed blank through `fill`, `fill --native`, and a
  React native-setter `eval`. There is no `press` or `type` command to escalate to.
  ⇒ Drop to raw CDP on the tab’s `webSocketDebuggerUrl` and dispatch `Input.dispatchKeyEvent`
  per character. Two traps, both hit:
  **(1) `keyDown` carrying `text` already inserts the character** — sending a `char` event as well
  types everything twice (`ggeenneerraattiivvee…`), which reads as a flaky page rather than a double
  dispatch. Send `keyDown` + `keyUp` only.
  **(2) Clear with real Backspaces, not select-all+Delete.** A value written by a JS setter is
  invisible to the component’s own state, so the framework keeps the old string and you end up
  appending to it. Backspacing drives the same path a person would.
  Also: the dropdown must actually be **open** first — typing into a collapsed picker’s hidden input
  does nothing, and looks identical to the events not landing.
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

## WebAuthn / security keys

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

## Controlled-form state stickiness

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

## File upload

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
