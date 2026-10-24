// `--clone-profile`: seed a NEW login context's Chrome profile from a copy of
// the automation profile, so it starts with the same extensions (and, by the
// same token, the same logins). Opt-in only: a context that silently started
// signed in to everything the automation profile is signed in to would be the
// opposite of a separate account.
//
// Measured 2026-10-24 on Chrome 155 / macOS 27, against the live automation
// profile (6.5 GB on disk):
//   - Copying Default/ + `Local State` without caches: 378 MB in 4s. Chrome
//     accepted it — every extension ENABLED, no tamper or corrupt flags, the
//     cookies there — but EVERY extension worker failed to start
//     (`DidStartWorkerFail …: 5`), so Bitwarden never hooked a page.
//   - The same with `Service Worker/` kept: 749 MB. All nine extension workers
//     started, Bitwarden wrapped `navigator.credentials` on dash.cloudflare.com,
//     and the log had no worker failures. So `Service Worker/` is kept.
// Only Chrome's own caches and its lock files are left out; the lock files
// (`Singleton*`) would make the copy look like a profile already in use.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

/** Top-level entries a profile needs. The rest of a user-data-dir is Chrome-wide state and caches. */
const TOP = new Set(['Local State', 'First Run', 'Default'])

/** Cache folders, anywhere: Chrome rebuilds every one of them. */
const CACHES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'GPUPersistentCache', 'Shared Dictionary',
  'Crashpad', 'BrowserMetrics', 'DeferredBrowserMetrics', 'component_crx_cache', 'extensions_crx_cache',
  'optimization_guide_model_store', 'OptGuideOnDeviceModel', 'OptGuideOnDeviceClassifierModel',
  'OnDeviceHeadSuggestModel',
])

function keep(src: string, root: string): boolean {
  const rel = relative(root, src)
  if (rel === '') return true
  const parts = rel.split(sep)
  if (!TOP.has(parts[0])) return false
  const name = basename(src)
  if (CACHES.has(name)) return false
  if (name.startsWith('Singleton') || name === 'LOCK' || name === 'RunningChromeVersion' || name === 'DevToolsActivePort') return false
  return true
}

const vanished = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * The automation Chrome is usually RUNNING while this copies, and it deletes
 * files under us — database journals, temp files. Node's cpSync aborts on the
 * first one: the first live `--clone-profile` died 878 MB in, leaving a
 * half-copied profile and no context (2026-10-24). A file that vanished
 * between listing and copying is one Chrome no longer needed, so skip it.
 */
function copyTree(src: string, dst: string, root: string): void {
  mkdirSync(dst, { recursive: true })
  let entries
  try { entries = readdirSync(src, { withFileTypes: true }) } catch (e) { if (vanished(e)) return; throw e }
  for (const ent of entries) {
    const s = join(src, ent.name)
    const d = join(dst, ent.name)
    if (!keep(s, root)) continue
    try {
      if (ent.isDirectory()) copyTree(s, d, root)
      else if (ent.isSymbolicLink()) symlinkSync(readlinkSync(s), d)
      else if (ent.isFile()) copyFileSync(s, d)
      // sockets, fifos: live-process plumbing, nothing a profile needs
    } catch (e) {
      if (!vanished(e)) throw e
    }
  }
}

/** Copy `from` (a user-data-dir) into the empty `to`. Throws if `to` already holds a profile. */
export function cloneProfile(from: string, to: string): void {
  if (!existsSync(join(from, 'Default'))) throw new Error(`no profile to copy at ${from} (no Default/ in it)`)
  if (existsSync(to) && readdirSync(to).length) throw new Error(`${to} is not empty; --clone-profile only seeds a new context`)
  try {
    copyTree(from, to, from)
  } catch (e) {
    // Never leave half a copy behind: it holds the automation profile's cookies.
    rmSync(to, { recursive: true, force: true })
    throw e
  }
}
