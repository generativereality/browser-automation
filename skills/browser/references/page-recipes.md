# Page recipes — controls that need more than `click`

Each of these looks like "the site is broken" or "the ref went stale" the first time, and
each cost a real session at least one wrong diagnosis.

## Clicks: synthetic and trusted are BOTH needed, on different controls

Never generalise from one control. On the same site, a dropdown menu ignored untrusted
clicks and needed `click --trusted`, while a link-styled **Withdraw** anchor was the
reverse: `Input.dispatchMouseEvent` at its centre silently did nothing, and `el.click()`
opened the confirm dialog every time. Try both before concluding a control is broken.

## Radix menus open on `pointerdown`

A Radix `DropdownMenu` or a row "⋯" trigger will not open from `click`, nor from a bare
`element.click()`. Radix listens on `pointerdown`, so you get a snapshot with no
`[role=menuitem]` in it. Send pointer events **plus** a real click, and return the items
in the same call so you see at once whether it opened:

```bash
browser-automation eval -s app '(() => {
  const b = [...document.querySelectorAll("button")].find(x => /Open menu/.test(x.getAttribute("aria-label") || x.textContent));
  const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 };
  b.dispatchEvent(new PointerEvent("pointerdown", o));
  b.dispatchEvent(new PointerEvent("pointerup", o));
  b.click();
  return [...document.querySelectorAll("[role=menuitem]")].map(x => x.textContent.trim()).join(" | ");
})()'
```

⚠️ **Do not fire `click` and then this sequence.** Two activations toggle the menu open
and shut again, which looks identical to it never opening. Once it is open, the menu
items and dialog buttons take an ordinary `click [ref]` after a re-snapshot; only the
trigger needs pointer events.

## Dialogs: filter by visibility, not by role

A page can hold several hidden `[role=dialog]` nodes (search overlays, ad-option panels).
`querySelector('[role=dialog]')` returns an empty one, and your automation reports "no
button" after an action that actually worked. Match `offsetParent !== null` (or `.open`)
**plus** the text you expect.

## Infinite scroll stalls in a background tab

Chrome throttles timers and IntersectionObservers in unfocused tabs, so a lazy-loading
list stops after a page or two however you scroll it, and it fails by **stalling
silently**, which reads as "the list is capped". Measured on a 144-row list: window
scroll, container `scrollTop`, synthetic `wheel` events and a 12000px emulated viewport
all stalled at 30 rows; bringing the tab to the front walked the same loop to 144,
matching the count in the page's own header.

So when a list "won't paginate", **make the tab render before concluding anything about
the site**: `focus -s [session]` first, and if the count still stalls, `focus --raise`,
which really fronts the tab. ⚠️ `--raise` takes the operator's screen, so keep it to a
bounded step and tell them. Then scroll until the row count stops rising, and check it
against whatever count the page displays.

⛔ **`Emulation.clearDeviceMetricsOverride` does not reliably restore the real
viewport.** If you override device metrics, set them back to the real size explicitly.
Otherwise `getBoundingClientRect` coordinates are computed in a viewport the window does
not have, and every coordinate-based click lands nowhere and reports success.

## Rich composers accept `fill` and still submit nothing

`contenteditable` composers wired to React show your text in the DOM while React's state
stays empty, so the **Send** button never enables, and re-reading the element confirms
your text, which makes it look like a UI bug. Use `fill --native` on such a composer from
the start. ⛔ Clearing it with `el.innerHTML = ""` makes it worse: it can collapse the
whole action row until a reload.

## Log out, then navigate, as separate calls

A logout `fetch` and a `goto` in one chain race: the logout returns `{"success":true}`
and you still land on the signed-in page, because the navigation resolves against a
session the request has not finished clearing. The tell is a login URL that renders
signed-in content. Issue the request, confirm it returned, then `goto` in a **separate**
invocation and assert `location.pathname`.

## Attach an image to a GitHub PR or issue

A committed image cannot be shown in a PR body on a **private** repo: GitHub's image
proxy fetches without the viewer's credentials, so `…/blob/[sha]/x.png?raw=true` renders
broken (`naturalWidth: 0`). Only a **user-attachment** renders, and that exists only
because a browser uploaded it.

⭐ **Stamp the ref yourself.** The comment form's file input is `display:none`, so
`snapshot` never gives it an `eN` ref, and `setfiles` needs one. Setting the attribute
by hand is enough:

```bash
browser-automation goto -s pr "https://github.com/[org]/[repo]/pull/[n]"
# 1. The comment form is lazy-rendered; wait until it exists.
browser-automation eval -s pr 'document.querySelector("input#fc-new_comment_field") ? "ready" : "waiting"'
# 2. Stamp a ref on the input, then setfiles.
browser-automation eval -s pr '(() => { document.querySelector("input#fc-new_comment_field").setAttribute("data-ba-ref", "e998"); return "ok"; })()'
browser-automation setfiles -s pr e998 /abs/one.png /abs/two.png
# 3. Poll the textarea until every upload has landed, then read the URLs out.
browser-automation eval -s pr '(() => String((document.querySelector("textarea#new_comment_field").value.match(/user-attachments\/assets\/[0-9a-f-]+/g) || []).length))()'
browser-automation eval -s pr 'document.querySelector("textarea#new_comment_field").value'
# 4. Clear the draft with the native value setter. Do NOT submit the comment.
browser-automation eval -s pr '(() => { const t = document.querySelector("textarea#new_comment_field"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ""); t.dispatchEvent(new Event("input", { bubbles: true })); return t.value === ""; })()'
# 5. Put the harvested <img> tags into the body: gh pr edit --body-file …
```

The uploaded URLs are plain text from then on, so **harvest them, don't re-upload**, and
place them anywhere, including the PR description via `gh pr edit`. If ref-stamping ever
stops working, raw per-tab CDP `DOM.setFileInputFiles` on `input[type="file"]` is what
`setfiles` does internally, and it fires the trusted `input`/`change` GitHub listens for.

Traps:

- ⛔ **`upload --click` on "Paste, drop, or click to add files" reports success and
  stages nothing.** *"delivered N file(s) to the page's file handler via chooser"* means
  delivery to *a* handler, not GitHub accepting the files; the textarea stays empty.
- `snapshot` caps at about 200 elements, so on a long PR the attach control never gets a
  ref. A hand-stamped ref must be shaped `e[number]`; anything else is rejected.
- The description editor itself is not reachable this way (its menu renders lazily).
  Use `gh pr edit` for the body and the browser only for the upload.
- **Verify the images render, not that the markup is there.** Attachments go through a
  proxy, so filter on `alt` rather than `src`, force lazy images to load
  (`img.loading = "eager"`), and assert `naturalWidth > 0`. An image below the fold
  reports 0 only because it has not loaded.
- A mid-session "Single sign-on to [org]" wall is normal on an enterprise org; its
  **Continue** resumes an already-valid IdP session. If it asks for credentials or MFA,
  stop and hand back to the operator.
