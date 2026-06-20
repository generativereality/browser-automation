// File upload — the two Playwright-equivalent paths for getting local files into
// a page. Both end in `DOM.setFileInputFiles`, which is the ONLY reliable way to
// populate an `<input type=file>`: a file input's `.files` is read-only to page
// JS, and even a native value-setter won't route through a React onChange. CDP
// sets it for real and fires `input`/`change` as a trusted user selection would.
//
// 1. setFilesByRef — for a KNOWN, static `<input type=file>` you can snapshot and
//    address by ref. Resolve the ref to a RemoteObject and set its files.
//
// 2. uploadViaChooser — for the common "custom button" case where there is no
//    addressable input: a button creates a *transient* `<input type=file>`, clicks
//    it, and reads the file only while the OS chooser is open (App Store Connect's
//    "Attach File" does exactly this). Setting the static input is useless — the
//    handler uses its own throwaway input. So we intercept the chooser
//    (`Page.setInterceptFileChooserDialog`), click the trigger, and when Chrome
//    fires `Page.fileChooserOpened` we get the backendNodeId of whichever input it
//    actually opened and set files on THAT. Playwright's `fileChooser` /
//    `setInputFiles`, same mechanism.
//
//    The hard case (ASC in the wild): the transient input is created and `.click()`d
//    but NEVER appended to the document, and the page reads it through a *delegated*
//    change listener (React's synthetic events, or a container-level handler) rather
//    than one bound to the node itself. `DOM.setFileInputFiles` does set `.files` and
//    fire a `change`, but on a detached node that `change` has no document ancestors
//    to bubble through, so the delegated handler never runs — the upload silently
//    no-ops (reports success, nothing stages). A node with its OWN listener works
//    detached; a delegated one does not. So after setting files we VERIFY the node,
//    and if it's detached we re-attach it (hidden) and re-dispatch bubbling
//    input/change so delegation fires — then report what actually staged.

import { withPage } from './cdp.js'
import { clickExpr, findRefExpr } from './dom.js'

export interface SetFilesResult {
  tag: string
  type: string
  files: string[]
}

export interface UploadResult {
  backendNodeId: number
  files: string[]
  /** Files present on the node AFTER the operation. Often 0 even on success:
   *  many uploaders (App Store Connect included) reset the input to "" once their
   *  change handler has consumed the file, so use `delivered`, not this, to judge
   *  success. */
  count: number
  /** Files the input held when the `change` event actually fired — i.e. what the
   *  page's handler saw. >=1 means the file was delivered to the handler, even if
   *  the input was reset to 0 afterward. This is the real success signal. */
  delivered: number
  /** Was the node connected to the document when we set files? */
  connected: boolean
  /** Did we have to re-attach a detached transient input + re-dispatch events? */
  reconnected: boolean
}

/** Set files on a known input[type=file] addressed by ref. */
export async function setFilesByRef(
  targetId: string,
  ref: string,
  files: string[],
): Promise<SetFilesResult> {
  return withPage(targetId, async (s) => {
    await s.send('DOM.enable')

    const ev = await s.send('Runtime.evaluate', {
      expression: findRefExpr(ref),
      returnByValue: false,
    })
    if (ev.exceptionDetails) {
      const e = ev.exceptionDetails
      throw new Error('resolving ref failed: ' + (e.exception?.description || e.text || 'unknown'))
    }
    const objectId: string | undefined = ev.result?.objectId
    if (!objectId) throw new Error(`ref not found: ${ref} (re-run \`browser-automation snapshot\`)`)

    // Describe the node so we can validate it's a file input and report it.
    const desc = await s.send('DOM.describeNode', { objectId })
    const node = desc.node ?? {}
    const tag = String(node.nodeName ?? '').toLowerCase()
    const attrs: string[] = node.attributes ?? []
    let type = ''
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'type') type = attrs[i + 1]
    if (tag !== 'input' || type.toLowerCase() !== 'file') {
      throw new Error(
        `ref ${ref} is <${tag}${type ? ` type=${type}` : ''}>, not <input type=file>. ` +
          `For a custom "attach" button that opens a file chooser, use \`browser-automation upload --click ${ref} …\` instead.`,
      )
    }

    // setFileInputFiles fires input + change as a trusted selection would.
    await s.send('DOM.setFileInputFiles', { objectId, files })
    return { tag, type, files }
  })
}

/** Arm file-chooser interception, click the trigger, and set files on whatever
 *  input Chrome opens — handles transient/custom-button uploads. */
export async function uploadViaChooser(
  targetId: string,
  clickRef: string,
  files: string[],
  timeout = 15000,
): Promise<UploadResult> {
  return withPage(targetId, async (s) => {
    await s.send('Page.enable')
    await s.send('DOM.enable')
    await s.send('Page.setInterceptFileChooserDialog', { enabled: true })
    try {
      // Listener MUST be registered before the click — the chooser can open
      // synchronously inside the trigger's click handler.
      const opened = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no file chooser opened within ${timeout}ms after clicking ${clickRef} — is it the right trigger?`)),
          timeout,
        )
        s.on('Page.fileChooserOpened', (p: any) => {
          clearTimeout(timer)
          resolve(p.backendNodeId as number)
        })
      })

      // Click the trigger on THIS session so the chooser it opens is the one our
      // interception catches. userGesture so handlers gated on activation run.
      const click = await s.send('Runtime.evaluate', {
        expression: clickExpr(clickRef),
        returnByValue: true,
        userGesture: true,
      })
      const clickVal = click.result?.value
      if (clickVal && clickVal.err) throw new Error(clickVal.err)

      const backendNodeId = await opened

      // Resolve to a live JS handle BEFORE setting files, so we can (a) install a
      // one-shot `change` probe that records what the page's handler actually sees
      // — the real success signal, since apps reset the input to 0 right after
      // consuming it — and (b) re-attach the node if it's a detached transient
      // (the delegated-handler case that otherwise silently no-ops).
      let connected = true
      let reconnected = false
      let objectId: string | undefined
      try {
        const r = await s.send('DOM.resolveNode', { backendNodeId })
        objectId = r.object?.objectId
      } catch { /* fall back to backendNodeId-only set below */ }

      if (objectId) {
        const pre = await s.send('Runtime.callFunctionOn', {
          objectId,
          returnByValue: true,
          functionDeclaration: `function(){
            var el=this;
            var was=el.isConnected;
            var reattached=false;
            if(!el.isConnected){
              try{ el.style.display='none'; (document.body||document.documentElement).appendChild(el); reattached=true; }catch(e){}
            }
            // Record the file count at change-dispatch time — survives the app
            // resetting el.files to 0 immediately after its handler runs.
            el.__baDelivered = -1;
            el.addEventListener('change', function(e){ try{ el.__baDelivered = el.files ? el.files.length : 0; }catch(_){ el.__baDelivered = 0; } }, { once: true });
            return { connected: was, reconnected: reattached };
          }`,
        })
        const pv = pre.result?.value
        if (pv) { connected = pv.connected; reconnected = pv.reconnected }
      }

      // Set files (prefer objectId so it tracks a re-attached node; else backendNodeId).
      await s.send('DOM.setFileInputFiles', objectId ? { objectId, files } : { backendNodeId, files })

      let count = files.length
      let delivered = files.length
      if (objectId) {
        try {
          const post = await s.send('Runtime.callFunctionOn', {
            objectId,
            returnByValue: true,
            functionDeclaration: `function(){
              var el=this;
              // If the node was detached, the change from setFileInputFiles couldn't
              // reach a delegated handler — re-fire bubbling input+change now that
              // it's on the tree.
              if(${reconnected ? 'true' : 'false'}){
                try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){}
                try{ el.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
              }
              return { count: (el.files?el.files.length:0), delivered: (typeof el.__baDelivered==='number'?el.__baDelivered:-1) };
            }`,
          })
          const val = post.result?.value
          if (val) {
            count = val.count
            // delivered === -1 means our change listener never fired at all.
            delivered = val.delivered >= 0 ? val.delivered : 0
          }
        } catch { /* best-effort; keep optimistic defaults */ }
      }

      return { backendNodeId, files, count, delivered, connected, reconnected }
    } finally {
      try { await s.send('Page.setInterceptFileChooserDialog', { enabled: false }) } catch { /* ignore */ }
    }
  })
}
