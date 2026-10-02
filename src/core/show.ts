// `--show` / `BAC_SHOW_TAB`: make a session's tab the SELECTED tab in its window,
// so someone watching Chrome sees the page the agent is working on — and never
// at the price of bringing Chrome in front of another app.
//
// # Why only when Chrome is already in front
//
// Asked for from filming a real round: one tab sat unchanged for eleven minutes
// while the agent worked in background tabs. The obvious fix is
// `Target.activateTarget`, and it TAKES THE SCREEN. Measured 2026-09-29, Chrome
// 153 / macOS 27, Tabby frontmost, the frontmost app polled every 10-20ms:
//
//   Target.activateTarget          selects the tab   Tabby -> Google Chrome
//   Page.bringToFront              selects the tab   Tabby -> Google Chrome
//   GET /json/activate/<id>        selects the tab   Tabby -> Google Chrome
//   createTarget background:false  selects the tab   Tabby -> Google Chrome
//   window.open / focus() in page  selects the tab   Tabby -> Google Chrome
//   activate, then hand back       selects the tab   Chrome in front ~88ms, and
//                                                    keys typed then land in it
//   extension chrome.tabs.update   selects the tab   Tabby stays in front (0ms)
//
// The extension is the only quiet route, and Google Chrome will not keep one we
// install: `Extensions.loadUnpacked` needs a debugging PIPE (this CLI talks over
// a port, to a Chrome started through open(1)), and after a normal restart the
// extension's page fails to load, with or without --enable-unsafe-extension-
// debugging or developer mode. So it waits for a helper published to the Chrome
// Web Store and installed once — a follow-up, which will make this quiet in every
// case behind the SAME flag.
//
// Until then: select only when the automation Chrome is ALREADY the frontmost
// app. Then nothing is raised, because it is already up — which is exactly the
// case of someone watching it. Someone who switches to Chrome mid-round sees the
// right tab from the next --show on. What this cannot do is update a Chrome
// window that is visible beside another frontmost app.
//
// "The automation Chrome", by PID: the person's everyday Chrome is also "Google
// Chrome", and activating ours while theirs is in front would put the automation
// window over it — the exact theft this avoids.

import { execFileSync } from 'node:child_process'
import { activateTab } from './cdp.js'
import { browserPid, targetPort } from './renderer-health.js'
import { windowsForeground } from './windows-foreground.js'

export type ShowOutcome = 'shown' | 'not-frontmost' | 'unsupported'

/** On for this command: `--show`, or `BAC_SHOW_TAB=1` set once by a skill. */
export function wantsShow(flag: unknown): boolean {
  return flag === true || /^(1|true|yes|on)$/i.test(process.env.BAC_SHOW_TAB ?? '')
}

/**
 * Is the Chrome we drive the frontmost app? `null` when this platform cannot
 * say — which must not be treated as "yes".
 *
 * `lsappinfo`, not AppleScript: it needs no Accessibility or Automation grant,
 * and a permission dialog mid-command is worse than the problem.
 */
function ourChromeIsFrontmost(): boolean | null {
  // The fake Chrome in the test suite is not a process lsappinfo could report.
  const injected = process.env.BROWSER_AUTOMATION_TEST_FRONTMOST
  if (injected) return injected === 'chrome'
  if (process.platform === 'win32') {
    // GetForegroundWindow's owner vs the automation Chrome's browser process,
    // both from one PowerShell call (core/windows-foreground.ts). A 0 on either
    // side — no foreground window (locked, or a non-interactive session), or
    // no Chrome on our port — is "cannot say", never "yes".
    const w = windowsForeground(targetPort())
    if (!w || !w.foreground || !w.browser) return null
    return w.foreground === w.browser
  }
  if (process.platform !== 'darwin') return null
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!asn) return null
    const info = execFileSync('lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const front = Number(/pid\s*=\s*(\d+)/.exec(info)?.[1])
    const ours = browserPid()
    if (!front || !ours) return null
    return front === ours
  } catch {
    return null
  }
}

/** Select `targetId` in its window if, and only if, that raises nothing. */
export async function showTab(targetId: string): Promise<ShowOutcome> {
  const front = ourChromeIsFrontmost()
  if (front === null) return 'unsupported'
  if (!front) return 'not-frontmost'
  await activateTab(targetId)
  return 'shown'
}

/** One line for the agent when it asked and did not get it — never silent, never loud. */
export function describeNotShown(outcome: ShowOutcome): string | null {
  if (outcome === 'not-frontmost') {
    return 'Tab not shown: another app (or another Chrome) is in front, and --show never brings this Chrome over it. '
      + 'It selects the tab once the automation Chrome is in front.'
  }
  if (outcome === 'unsupported') {
    return 'Tab not shown: cannot tell which app is in front here (supported on macOS and Windows), so --show did nothing rather than risk taking the screen.'
  }
  return null
}
