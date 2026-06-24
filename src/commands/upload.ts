import { define } from 'gunshi'
import { consola } from 'consola'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { uploadViaChooser } from '../core/upload.js'

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

export const uploadCommand = define({
  name: 'upload',
  description: 'Upload via a button that opens a file chooser: intercept the chooser, click --click <ref>, set files on the input Chrome opens. Handles transient/custom inputs (App Store Connect "Attach File", React dropzones).',
  args: {
    ...targetArgs,
    click: { type: 'string', description: 'Ref of the trigger (button/link) that opens the file chooser (e.g. e42)' },
    timeout: { type: 'number', description: 'Max ms to wait for the chooser to open (default 15000)' },
    files: { type: 'positional', description: 'One or more file paths (absolute, or resolved from cwd)' },
  },
  async run(ctx) {
    const click = ctx.values.click as string | undefined
    const paths = ctx.positionals.slice(1)
    if (!click) { consola.error('--click <ref> is required (the button that opens the file chooser)'); process.exit(1) }
    if (!isValidRef(click)) { consola.error('--click expects a ref like e42 (run `browser-automation snapshot` first)'); process.exit(1) }
    if (paths.length === 0) { consola.error('At least one file path is required'); process.exit(1) }

    const files = absFiles(paths)
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const r = await uploadViaChooser(targetId, click, files, (ctx.values.timeout as number | undefined) ?? 15000)

    if (r.delivered === 0) {
      // The change event fired but the input held no files when it did — the page
      // tore the transient input down before we could set it. Real failure.
      consola.error(
        `the file chooser opened (backendNodeId ${r.backendNodeId}) but the file never reached the page's change handler — ` +
          `the page likely replaced/destroyed the transient input before it could be set. ` +
          `Re-snapshot and confirm --click points at the real trigger, or try again.`,
      )
      process.exit(1)
    }

    const note = r.reconnected
      ? ' (input was detached — re-attached and re-dispatched input/change so the page\'s handler fired)'
      : ''
    consola.success(`delivered ${r.files.length} file(s) to the page's file handler via chooser (backendNodeId ${r.backendNodeId})${note}:`)
    for (const f of r.files) process.stdout.write(f + '\n')
    if (r.count === 0) {
      // Delivered, but the input was reset to 0 — normal for apps that consume the
      // file then clear the input. We can't prove the app *staged* it from here.
      consola.info(
        'The app consumed the file and reset the input (normal). This confirms delivery, not staging — ' +
          're-snapshot or screenshot to verify the attachment chip/preview actually appeared before submitting.',
      )
    } else {
      consola.info('Re-snapshot to confirm the attachment chip/preview appeared before submitting — the DOM changed.')
    }
  },
})
