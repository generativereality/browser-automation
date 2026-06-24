import { cli, define, type Command } from 'gunshi'
import pkg from '../../package.json'
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
import { networkCommand } from './network.js'
import { screenshotCommand } from './screenshot.js'
import { listCommand } from './list.js'
import { closeCommand } from './close.js'
import { bindCommand } from './bind.js'
import { launchCommand } from './launch.js'
import { doctorCommand } from './doctor.js'

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
  ['network', networkCommand],
  ['screenshot', screenshotCommand],
  ['shot', screenshotCommand],
  ['list', listCommand],
  ['ls', listCommand],
  ['close', closeCommand],
  ['bind', bindCommand],
  ['launch', launchCommand],
  ['doctor', doctorCommand],
])

export async function run(): Promise<void> {
  await cli(process.argv.slice(2), defaultCommand, {
    name: 'browser-automation',
    version: pkg.version,
    description: pkg.description,
    subCommands,
    renderHeader: null,
  })
}
