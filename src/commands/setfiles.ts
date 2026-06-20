import { define } from 'gunshi'
import { consola } from 'consola'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { setFilesByRef } from '../core/upload.js'

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

export const setfilesCommand = define({
  name: 'setfiles',
  description: 'Set files on a known <input type=file> by ref (fires input/change). For a custom "attach" button that opens a file chooser, use `upload` instead.',
  args: {
    ...targetArgs,
    ref: { type: 'positional', description: 'Ref of the <input type=file> (run snapshot first)' },
    files: { type: 'positional', description: 'One or more file paths (absolute, or resolved from cwd)' },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    const paths = ctx.positionals.slice(2)
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e7" is required (run `browser-automation snapshot` first)'); process.exit(1) }
    if (paths.length === 0) { consola.error('At least one file path is required'); process.exit(1) }

    const files = absFiles(paths)
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const r = await setFilesByRef(targetId, ref, files)
    consola.success(`set ${r.files.length} file(s) on ${ref} <${r.tag} type=${r.type}>:`)
    for (const f of r.files) process.stdout.write(f + '\n')
  },
})
