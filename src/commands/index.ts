import { cli, define, type Command } from 'gunshi'
import pkg from '../../package.json'
import { canonicalize, restorePositionals, type ArgSpec } from '../core/argv.js'
import { newCommand } from './new.js'
import { gotoCommand } from './goto.js'
import { snapshotCommand } from './snapshot.js'
import { clickCommand } from './click.js'
import { fillCommand } from './fill.js'
import { readCommand } from './read.js'
import { evalCommand } from './eval.js'
import { downloadCommand } from './download.js'
import { setfilesCommand } from './setfiles.js'
import { uploadCommand } from './upload.js'
import { dropCommand } from './drop.js'
import { networkCommand } from './network.js'
import { screenshotCommand } from './screenshot.js'
import { listCommand } from './list.js'
import { closeCommand } from './close.js'
import { bindCommand } from './bind.js'
import { launchCommand } from './launch.js'
import { doctorCommand } from './doctor.js'
import { gcCommand } from './gc.js'
import { portCommand } from './port.js'

const defaultCommand = define({
  name: 'browser-automation',
  description: pkg.description,
  args: {},
  async run() {
    await listCommand.run?.call(this, { values: {} } as never)
  },
})

const subCommands = new Map<string, Command<any>>([
  ['new', newCommand],
  ['goto', gotoCommand],
  ['snapshot', snapshotCommand],
  ['snap', snapshotCommand],
  ['click', clickCommand],
  ['fill', fillCommand],
  ['read', readCommand],
  ['eval', evalCommand],
  ['download', downloadCommand],
  ['setfiles', setfilesCommand],
  ['upload', uploadCommand],
  ['drop', dropCommand],
  ['network', networkCommand],
  ['screenshot', screenshotCommand],
  ['shot', screenshotCommand],
  ['list', listCommand],
  ['ls', listCommand],
  ['close', closeCommand],
  ['bind', bindCommand],
  ['launch', launchCommand],
  ['doctor', doctorCommand],
  ['gc', gcCommand],
  ['prune', gcCommand],
  ['port', portCommand],
])

// The positionals gunshi sees are placeholders (see core/argv.ts). Each
// command runs with the real values swapped back in. The context is frozen,
// so it is copied rather than patched.
function withRealPositionals(cmd: Command<any>, real: readonly string[]): Command<any> {
  return {
    ...cmd,
    async run(ctx) {
      return cmd.run?.({ ...ctx, positionals: restorePositionals(ctx.positionals, real) })
    },
  }
}

export async function run(): Promise<void> {
  let argv = process.argv.slice(2)
  let commands = subCommands

  // Parse the arguments ourselves, POSIX-style, and hand gunshi a canonical
  // argv it cannot misread. Its own tokenizer treats an element that merely
  // CONTAINS `--` as an option, which made any prose mentioning a long flag
  // (or a markdown `---` rule) unsendable through `fill`.
  const sub = argv[0]
  const command = sub === undefined ? undefined : subCommands.get(sub)
  if (sub !== undefined && command) {
    const canonical = canonicalize(sub, argv.slice(1), (command.args ?? {}) as Record<string, ArgSpec>)
    argv = canonical.argv
    commands = new Map(subCommands)
    commands.set(sub, withRealPositionals(command, canonical.positionals))
  }

  await cli(argv, defaultCommand, {
    name: 'browser-automation',
    version: pkg.version,
    description: pkg.description,
    subCommands: commands,
    renderHeader: null,
    // gunshi prints validation errors (a genuinely missing positional) and
    // returns normally, which exited 0. A usage error is a failure.
    renderValidationErrors: async (_ctx, error) => {
      process.exitCode = 1
      return error.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('\n')
    },
  })
}
