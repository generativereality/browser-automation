import { define } from 'gunshi'
import { consola } from 'consola'
import { resolve, basename, extname } from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate, withPage, forceForeground } from '../core/cdp.js'
import { actionabilityExpr, dropExpr } from '../core/dom.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Resolve each path to absolute and verify it's an existing file. */
function absFiles(paths: string[]): string[] {
  return paths.map((p) => {
    const abs = resolve(p)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      consola.error(`no such file: ${abs}`)
      process.exit(1)
    }
    return abs
  })
}

/** Minimal extension→mime map for the --js path (where the page builds the File
 *  from bytes and needs a type). The trusted CDP path doesn't need this — Chrome
 *  reads the real file off disk and sets the type itself. */
function guessMime(p: string): string {
  const ext = extname(p).toLowerCase()
  const m: Record<string, string> = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain',
  }
  return m[ext] || 'application/octet-stream'
}

export const dropCommand = define({
  name: 'drop',
  description:
    'Drop local file(s) onto a drop-zone element by ref — for uploaders wired to drag-and-drop (a `drop` listener reading `e.dataTransfer.files`) rather than an <input type=file>. Default fires a genuinely-trusted CDP drag sequence (Input.dispatchDragEvent) carrying the real files from disk: brings the tab to front, waits for it to be focused+visible, waits for the target to be actionable (stable + unoccluded), then dragEnter→dragOver→drop — mirroring `click --trusted`. Use --js for a synthetic (isTrusted=false) DataTransfer drop that does NOT steal focus, for zones that accept synthetic events. For a static <input type=file> use `setfiles`; for a button that opens a file chooser use `upload`.',
  args: {
    ...targetArgs,
    on: { type: 'positional', description: 'Ref of the drop-zone element (run snapshot first), e.g. e7' },
    files: { type: 'positional', description: 'One or more file paths (absolute, or resolved from cwd)' },
    js: {
      type: 'boolean',
      description:
        'Dispatch a synthetic (isTrusted=false) DataTransfer drop instead of the trusted CDP path. Does not bring the tab to front (no focus steal). Injects each file\'s bytes into the page to build the File objects. Use for drop zones that accept synthetic events; falls short on zones that gate on isTrusted.',
    },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    const paths = ctx.positionals.slice(2)
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e7" is required (run `browser-automation snapshot` first)'); process.exit(1) }
    if (paths.length === 0) { consola.error('At least one file path is required'); process.exit(1) }

    const files = absFiles(paths)
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const useJs = ctx.values.js ?? false

    if (useJs) {
      // Synthetic path: inject bytes, build Files in-page, dispatch the drag
      // sequence. No focus steal; works where the zone doesn't require isTrusted.
      const specs = files.map((p) => ({ name: basename(p), type: guessMime(p), b64: readFileSync(p).toString('base64') }))
      const r = await evaluate<{ ok?: boolean; tag?: string; count?: number; err?: string }>(targetId, dropExpr(ref, specs))
      if (r.err) { consola.error(r.err); process.exit(1) }
      consola.success(`dropped ${r.count} file(s) on ${ref} <${r.tag}> (synthetic — re-snapshot/screenshot to confirm the zone accepted them):`)
      for (const f of files) process.stdout.write(f + '\n')
      return
    }

    // Trusted path: real CDP drag-drop carrying the files from disk. Same
    // foreground + actionability discipline as `click --trusted` — CDP input
    // no-ops on a backgrounded tab, and drag coordinates resolved on a still-
    // animating zone land on stale/occluded points.
    const tag = await withPage(targetId, async (s) => {
      const evalIn = async <T = unknown>(expr: string): Promise<T> => {
        const res = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        if (res.exceptionDetails) {
          const e = res.exceptionDetails
          throw new Error('page JS exception: ' + (e.exception?.description || e.text || 'unknown'))
        }
        return res.result?.value as T
      }

      // Force the tab focused+visible for trusted input (and the user activation
      // a drop-zone uploader needs) without stealing OS focus. See forceForeground.
      await forceForeground(s)
      // 1. Wait for the tab to actually be foreground (focused + visible).
      const focusDeadline = Date.now() + 2000
      while (Date.now() < focusDeadline) {
        const f = await evalIn<{ f: boolean; v: string }>(`({f:document.hasFocus(),v:document.visibilityState})`)
        if (f && f.f && f.v === 'visible') break
        await sleep(50)
      }

      // 2. Wait for the drop zone to be actionable: stable position + unoccluded.
      let prev: { x: number; y: number } | null = null
      let point: { x: number; y: number; tag: string } | null = null
      let lastReason = 'never became actionable'
      const actDeadline = Date.now() + 5000
      while (Date.now() < actDeadline) {
        const a = await evalIn<{ err?: string; tag: string; x: number; y: number; hit: boolean }>(actionabilityExpr(ref))
        if (a?.err) { consola.error(a.err); process.exit(1) }
        const stable = prev !== null && Math.abs(prev.x - a.x) < 0.5 && Math.abs(prev.y - a.y) < 0.5
        if (a.hit && stable) { point = { x: a.x, y: a.y, tag: a.tag }; break }
        lastReason = a.hit ? 'position not yet stable (still animating)' : 'drop-point occluded (hit-test miss)'
        prev = { x: a.x, y: a.y }
        await sleep(60)
      }
      if (!point) { consola.error(`<${ref}> not actionable for a drop: ${lastReason}`); process.exit(1) }

      const { x, y } = point
      // dragOperationsMask 1 = copy. Files are read off disk by Chrome, so the
      // resulting drop carries real File objects with correct name/size/type and
      // isTrusted=true. Sequence mirrors a real mouse drag onto the zone.
      const data = { items: [], files, dragOperationsMask: 1 }
      await s.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
      await s.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
      await sleep(20)
      await s.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
      return point.tag
    })

    consola.success(`dropped ${files.length} file(s) on ${ref} <${tag}> (trusted):`)
    for (const f of files) process.stdout.write(f + '\n')
    consola.info('Re-snapshot or screenshot to confirm the zone accepted the drop — the DOM changed.')
  },
})
