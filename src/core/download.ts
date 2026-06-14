// Download capture. The reliable path in current Chrome is the BROWSER-domain
// download API: arm `Browser.setDownloadBehavior` (eventsEnabled) on the browser
// session and listen for `Browser.downloadWillBegin` / `Browser.downloadProgress`.
// (The page-level `Page.downloadProgress` events are dead in Chrome 149.) The
// trigger (a click or anchor) runs in the page; the download is saved under its
// guid, then we rename it to the suggested filename. Playwright-equivalent of
// `page.waitForEvent('download')`.

import { connect, browserWsUrl, evaluate } from './cdp.js'
import { clickExpr } from './dom.js'
import { mkdirSync, renameSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface DownloadResult {
  path: string
  filename: string
  bytes: number
}

export async function captureDownload(
  targetId: string,
  dir: string,
  triggerExpr: string,
  timeout = 30000,
): Promise<DownloadResult> {
  mkdirSync(dir, { recursive: true })
  const browser = await connect(await browserWsUrl())
  try {
    await browser.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', // saved as <guid>; we rename to suggestedFilename
      downloadPath: dir,
      eventsEnabled: true,
    })

    const names = new Map<string, string>() // guid -> suggestedFilename
    const done = new Promise<DownloadResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`download did not complete within ${timeout}ms`)),
        timeout,
      )
      browser.on('Browser.downloadWillBegin', (p: any) => {
        if (p?.guid) names.set(p.guid, p.suggestedFilename || p.guid)
      })
      browser.on('Browser.downloadProgress', (p: any) => {
        if (p?.state === 'completed') {
          clearTimeout(timer)
          const guidPath = join(dir, p.guid)
          const name = names.get(p.guid) || p.guid
          let finalPath = guidPath
          try {
            if (name !== p.guid && existsSync(guidPath)) {
              renameSync(guidPath, join(dir, name))
              finalPath = join(dir, name)
            }
          } catch { /* keep guid path */ }
          let bytes = p.receivedBytes ?? 0
          try { bytes = statSync(finalPath).size } catch { /* ignore */ }
          resolve({ path: finalPath, filename: name, bytes })
        } else if (p?.state === 'canceled') {
          clearTimeout(timer)
          reject(new Error('download was canceled'))
        }
      })
    })

    // Trigger runs in the page (its own short-lived connection); the browser
    // session above still receives the download events.
    await evaluate(targetId, triggerExpr, { userGesture: true })
    return await done
  } finally {
    browser.close()
  }
}

export function clickTriggerExpr(ref: string): string {
  return clickExpr(ref)
}

export function urlTriggerExpr(url: string): string {
  const u = JSON.stringify(url)
  return `(() => { const a=document.createElement('a'); a.href=${u}; a.download=''; document.body.appendChild(a); a.click(); a.remove(); return true; })()`
}
