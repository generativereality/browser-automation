#!/usr/bin/env node
import updateNotifier from 'update-notifier'
import { run } from './commands/index.js'
import pkg from '../package.json'

// Don't crash when our stdout is piped into something that exits early
// (e.g. `… | head`). Agents pipe constantly.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

// Non-blocking daily update check, plus our own one-line warning.
//
// `notifier.notify()` prints a boxed banner only on a TTY — and the caller here is usually not
// one. An agent shells out to this CLI, captures stdout, and would never learn it is driving an
// old build: it just gets the old behaviour, silently, and concludes the CLI cannot do the thing
// rather than that it needs upgrading. That failure is invisible from inside the session, so the
// plain line matters more than the pretty box.
//
// Same shape as cctabs, deliberately: both are driven by the same agents, and a warning they
// already recognise costs nothing to read.
const notifier = updateNotifier({ pkg })
notifier.notify()
if (notifier.update && notifier.update.latest !== notifier.update.current) {
  const { current, latest } = notifier.update
  process.stdout.write(
    `[browser-automation] OUTDATED ${current} < ${latest} — run: npm install -g ${pkg.name}@latest\n`,
  )
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
