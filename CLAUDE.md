# browser-automation

Daemonless, per-tab-isolated browser automation CLI (`@generativereality/browser-automation`,
bin `browser-automation`) that drives one shared headed Chrome on `:9223` over
per-target Chrome DevTools Protocol. See `README.md` and `skills/browser/SKILL.md`.

## Versioning policy — READ THIS

**The CLI itself is the feature.** Rounding it out and fixing it are *bug fixes*:

- **Adding a missing capability/command** (screenshot, download, network, wait,
  pdf, …) or **fixing a shortcoming** → **patch** release (`0.x.Z+1`). These are
  *not* "new features" — they're completing the CLI.
- **A genuinely new feature beyond completing the CLI** → minor (`0.Y+1.0`).
  Rare. Flag it and confirm with the user first.
- Major → reserved for 1.0 / breaking changes.

(History note: `network` shipped as 0.3.1 and `screenshot` as 0.4.0 as *minors* —
that was wrong by this rule; they were gap-fills = patches. Left as-is; future
gap-fills are patches: 0.4.1, 0.4.2, …)

## Publishing — ONLY on explicit user go-ahead

**Never `npm publish` (or bump versions to publish) on your own initiative.**
Default loop while iterating:

1. Make the change in `src/`.
2. `npm run typecheck && npm run build`, then validate against the running Chrome
   by running **`node dist/index.js …`** from the repo. **Do NOT `npm link`** — it
   hijacks the machine-global `browser-automation` bin, so parallel sessions (and
   the user's main session) would run your WIP clone instead of the release. Test
   on a scratch tab you created — never disrupt the user's live tabs.
3. `git commit` locally.
4. **Tell the user what's staged & unpublished. Wait for an explicit "publish".**

When the user says publish:

1. Bump the version in **both** `package.json` and `.claude-plugin/plugin.json`
   (keep in sync) per the policy above (patch for gap-fills/fixes).
2. `git commit && git push`.
3. `npm publish` (granular token in `~/.npmrc`; never prompt for OTP).
4. `npm run sync-plugin` — syncs `plugin.json` + `SKILL.md` to `../plugins`,
   commits, pushes (so `/plugin install browser-automation@generativereality`
   gets the update).

One fix vs one feature = separate commits and separate version bumps. Don't
bundle a fix into a feature release.

## Dev gotchas

- The agent shell runs with `set -e -o pipefail` — `grep`/`head` returning
  non-zero (no match, SIGPIPE) aborts a chained script. Keep verification
  `grep`s out of release sequences, or append `|| true`.
- `data:` URLs and `about:`/`blob:` don't take a `https://` prefix — see
  `normalizeUrl` in `src/core/target.ts`.

## Key files

- `src/index.ts` — entry (stdout EPIPE-safe).
- `src/commands/*.ts` — one file per subcommand; registered in `src/commands/index.ts`.
- `src/core/cdp.ts` — per-target CDP: connect/eval/navigate/screenshot, `evaluateUntil` auto-wait.
- `src/core/dom.ts` — injected snapshot/click/fill/read JS (pierces shadow DOM + same-origin iframes).
- `src/core/resolve.ts` + `args.ts` — tab selection (`-s`/`-m`/`-t`, prefix-matched targetIds).
- `src/core/session.ts` — per-session JSON under `~/.browser-automation/sessions/`.
- `src/core/{download,network}.ts` — download capture + network inspection.
- `skills/browser/SKILL.md` — the Claude Code skill (synced to `generativereality/plugins`).
- `.claude-plugin/plugin.json` — manifest; version must match `package.json`.
