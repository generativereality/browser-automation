// How a NEW login context's Chrome profile starts (core/context-select.ts).
// The source is only ever the AUTOMATION profile. The user's ordinary Chrome
// profile is never copied: an automation browser signed in to everything an
// everyday browser is would be dangerous and confusing.
//
//   extensions (default)  the automation profile's EXTENSIONS and their data —
//                         a password manager stays installed and signed in —
//                         but no site cookies, saved passwords, site storage,
//                         history or open tabs, and NOT signed in to Chrome.
//   full (--full-copy)    everything, logins included.
//   empty (--empty-profile) nothing.
//
// # Why extensions-only is the default (2026-10-24)
//
// A full copy took every personal login along. The automation profile is
// signed in to CHROME with Fred's personal Google account, so in a copied
// `gapminder` context that account became the default Google account:
// admin.google.com went to the personal account's passkey challenge, and
// `?authuser=` did not move it. A project context wants the password manager,
// not the other accounts.
//
// # What was measured, on Chrome 155 / macOS 27, against the live profile
//
//   - Default/ + `Local State` without caches: every extension ENABLED, no
//     tamper flags — but every extension worker failed to start
//     (`DidStartWorkerFail …: 5`) until `Service Worker/Database` and
//     `ScriptCache` were kept. Its `CacheStorage` (sites' caches) is not needed.
//   - Extensions-only, as below: Bitwarden's worker ran and wrapped
//     `navigator.credentials` on dash.cloudflare.com, zero worker failures,
//     zero google.com/github.com cookies, and Chrome came up signed out
//     (`account_info` absent after Chrome's own save). 135 MB.
//   - Copying while the automation Chrome runs: it deletes files under us, and
//     cpSync aborted 878 MB in on the first one. Hence the walker below, which
//     skips files that vanished.
//
// # Telling the windows apart
//
// Each context's profile is given its context's NAME (profile button) and a
// COLOUR theme, because the windows of two Chromes are otherwise identical —
// Fred could not tell which was which while signing in (2026-10-24). The keys
// are the ones Chrome 155 itself writes when a colour is picked in Customize
// Chrome (diffed from Preferences): `browser.theme.user_color2`,
// `browser.theme.color_variant2`, `extensions.theme.id = user_color_theme_id`.
// Written before start-up they survived Chrome's own save and showed on the
// window; the older `browser.theme.user_color` was silently ignored. Variant 3
// (vibrant), because the default tonal tint is barely visible in dark mode.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

export type SeedMode = 'extensions' | 'full' | 'empty'

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

/**
 * What a site — and the person's accounts on it — leaves in a profile, by
 * path under Default/. Left out of an extensions-only copy. Extension data
 * lives elsewhere (Extensions/, Local Extension Settings/, Extension State/,
 * Extension Cookies, Service Worker/Database + ScriptCache) and is kept.
 */
const SITE_DATA = new Set([
  'Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal', 'Login Data For Account',
  'Login Data For Account-journal', 'Account Web Data', 'Account Web Data-journal', 'Web Data',
  'Web Data-journal', 'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Storage',
  'File System', 'blob_storage', 'Sessions', 'Sessions_Encrypted', 'History', 'History-journal',
  'Top Sites', 'Top Sites-journal', 'Visited Links', 'Favicons', 'Favicons-journal', 'Shortcuts',
  'Shortcuts-journal', 'Network Action Predictor', 'Network Action Predictor-journal', 'Trust Tokens',
  'Trust Tokens-journal', 'Reporting and NEL', 'Reporting and NEL-journal', 'Network Persistent State',
  'DIPS', 'DIPS-wal', 'Sync Data', 'Device Bound Sessions', 'Device Bound Sessions-journal',
  'passkey_enclave_state', join('Service Worker', 'CacheStorage'),
  // Where current Chrome keeps the network-layer ones: under Default/Network/.
  // Missing these, an extensions-only copy on Windows (Chrome 156) took the
  // automation profile's site COOKIES along, and failed only because Chrome
  // holds that file locked there: EBUSY on Network\Cookies (2026-10-27).
  ...['Cookies', 'Cookies-journal', 'Network Persistent State', 'Reporting and NEL', 'Reporting and NEL-journal',
    'Trust Tokens', 'Trust Tokens-journal', 'Device Bound Sessions', 'Device Bound Sessions-journal', 'SCT Auditing Pending Reports']
    .map((f) => join('Network', f)),
])

function keep(src: string, root: string, mode: SeedMode): boolean {
  const rel = relative(root, src)
  if (rel === '') return true
  const parts = rel.split(sep)
  if (!TOP.has(parts[0])) return false
  const name = basename(src)
  if (CACHES.has(name)) return false
  if (name.startsWith('Singleton') || name === 'LOCK' || name === 'RunningChromeVersion' || name === 'DevToolsActivePort') return false
  if (mode === 'extensions' && parts[0] === 'Default' && SITE_DATA.has(parts.slice(1).join(sep))) return false
  return true
}

const vanished = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Recursive copy that skips files the running automation Chrome deletes under us. */
function copyTree(src: string, dst: string, root: string, mode: SeedMode): void {
  mkdirSync(dst, { recursive: true })
  let entries
  try { entries = readdirSync(src, { withFileTypes: true }) } catch (e) { if (vanished(e)) return; throw e }
  for (const ent of entries) {
    const s = join(src, ent.name)
    const d = join(dst, ent.name)
    if (!keep(s, root, mode)) continue
    try {
      if (ent.isDirectory()) copyTree(s, d, root, mode)
      else if (ent.isSymbolicLink()) symlinkSync(readlinkSync(s), d)
      else if (ent.isFile()) copyFileSync(s, d)
      // sockets, fifos: live-process plumbing, nothing a profile needs
    } catch (e) {
      if (!vanished(e)) throw e
    }
  }
}

function readJson(path: string): Record<string, any> {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

/** Take Chrome's own Google sign-in out of a copied profile: the copy must not be the person's account. */
function signOutOfChrome(profileRoot: string): void {
  const prefsPath = join(profileRoot, 'Default', 'Preferences')
  const prefs = readJson(prefsPath)
  for (const k of ['account_info', 'google', 'signin', 'sync', 'gaia_cookie', 'account_tracker_service_last_update']) delete prefs[k]
  writeJson(prefsPath, prefs)
  const statePath = join(profileRoot, 'Local State')
  if (existsSync(statePath)) {
    const state = readJson(statePath)
    const cache = state.profile?.info_cache?.Default
    if (cache) {
      for (const k of ['gaia_id', 'gaia_name', 'gaia_given_name', 'user_name', 'hosted_domain', 'gaia_picture_file_name',
        'last_downloaded_gaia_picture_url_with_size', 'is_consented_primary_account']) delete cache[k]
      writeJson(statePath, state)
    }
  }
}

/** Seed `to` (empty) from the automation profile `from`. Throws if `to` already holds a profile. */
export function seedProfile(from: string, to: string, mode: SeedMode): void {
  if (existsSync(to) && readdirSync(to).length) throw new Error(`${to} is not empty; only a new context is seeded`)
  if (mode === 'empty' || !existsSync(join(from, 'Default'))) {
    mkdirSync(join(to, 'Default'), { recursive: true })
    return
  }
  try {
    copyTree(from, to, from, mode)
    if (mode === 'extensions') signOutOfChrome(to)
    // A profile copied from a RUNNING Chrome is marked as not shut down
    // cleanly, and opens on a "Restore pages?" prompt with the source's tabs
    // behind it. It was shut down fine; it was copied.
    const prefsPath = join(to, 'Default', 'Preferences')
    const prefs = readJson(prefsPath)
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true }
    writeJson(prefsPath, prefs)
  } catch (e) {
    // Never leave half a copy behind: it can hold the automation profile's cookies.
    rmSync(to, { recursive: true, force: true })
    throw e
  }
}

/** Distinct colours for contexts, in order of creation. ARGB. */
export const CONTEXT_COLORS: Array<{ name: string; argb: number }> = [
  { name: 'purple', argb: 0xff7b1fa2 },
  { name: 'teal', argb: 0xff00897b },
  { name: 'orange', argb: 0xffef6c00 },
  { name: 'blue', argb: 0xff1565c0 },
  { name: 'rose', argb: 0xffc2185b },
  { name: 'green', argb: 0xff2e7d32 },
  { name: 'brown', argb: 0xff6d4c41 },
  { name: 'indigo', argb: 0xff3949ab },
]

/**
 * Name the profile after its context and give it its colour. Only while the
 * context's Chrome is NOT running: Chrome holds these in memory and would
 * write its own copy back over them.
 */
export function personalizeProfile(profileRoot: string, name: string, argb: number): void {
  const prefsDir = join(profileRoot, 'Default')
  mkdirSync(prefsDir, { recursive: true })
  const prefsPath = join(prefsDir, 'Preferences')
  const prefs = readJson(prefsPath)
  prefs.profile = { ...(prefs.profile ?? {}), name }
  prefs.browser = { ...(prefs.browser ?? {}), theme: { ...(prefs.browser?.theme ?? {}), user_color2: argb | 0, color_variant2: 3 } }
  prefs.extensions = { ...(prefs.extensions ?? {}), theme: { ...(prefs.extensions?.theme ?? {}), id: 'user_color_theme_id' } }
  writeJson(prefsPath, prefs)
  const statePath = join(profileRoot, 'Local State')
  const state = readJson(statePath)
  state.profile ??= {}
  state.profile.info_cache ??= {}
  state.profile.info_cache.Default = { ...(state.profile.info_cache.Default ?? {}), name, is_using_default_name: false }
  writeJson(statePath, state)
}
