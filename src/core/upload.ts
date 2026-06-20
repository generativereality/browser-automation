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
      await s.send('DOM.setFileInputFiles', { backendNodeId, files })
      return { backendNodeId, files }
    } finally {
      try { await s.send('Page.setInterceptFileChooserDialog', { enabled: false }) } catch { /* ignore */ }
    }
  })
}
