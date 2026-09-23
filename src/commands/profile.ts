import { define } from 'gunshi'
import { consola } from 'consola'
import { migrateProfile, resolveProfile } from '../core/profile.js'

export const profileCommand = define({
  name: 'profile',
  description:
    "Print the Chrome profile directory this user's automation browser uses (one path, for scripts). "
    + '--migrate moves a profile from the old location inside Chrome\'s own folder to ~/.browser-automation/chrome-profile, keeping every login.',
  args: {
    migrate: {
      type: 'boolean',
      description: 'Move the profile out of ~/Library/Application Support/Google/Chrome/ into ~/.browser-automation/chrome-profile. Refuses — and changes nothing — if a Chrome has it open or this process may not move it.',
    },
  },
  async run(ctx) {
    if (!ctx.values.migrate) {
      // **Bare, on stdout, nothing else** — same contract as `port`. The launch
      // script asks this rather than keeping its own copy of the default, which
      // is how two answers to the port question happened.
      process.stdout.write(`${resolveProfile().dir}\n`)
      return
    }
    const m = migrateProfile()
    switch (m.outcome) {
      case 'moved':
        consola.success(`Profile ${m.detail}. Logins travel with it.`)
        return
      case 'current':
        consola.info(`Profile already at ${m.dir}.`)
        return
      case 'fresh':
        consola.info(`No existing profile. Chrome will create ${m.dir} on first launch.`)
        return
      case 'explicit':
        consola.info(`BROWSER_AUTOMATION_PROFILE is set (${m.dir}); leaving it where you put it.`)
        return
      default:
        // Not moved is not a success, whatever the reason — a caller that
        // chains off this must be able to tell.
        consola.warn(`Profile not moved — ${m.detail}`)
        process.exitCode = 1
    }
  },
})
