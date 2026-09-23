# browser-automation

Daemonless, per-tab-isolated browser automation CLI (`@generativereality/browser-automation`,
bin `browser-automation`) that drives one shared headed Chrome **per user** (a
uid-derived debugging port; `9223` for the first account) over
per-target Chrome DevTools Protocol. See `README.md` and `skills/browser/SKILL.md`.

## Versioning policy — READ THIS

**The CLI itself is the feature.** Rounding it out and fixing it are *bug fixes*:

- **Adding a missing capability/command** (screenshot, download, network, wait,
  pdf, focus, …) or **fixing a shortcoming** → **patch** release (`0.x.Z+1`).
  These are *not* "new features" — they're completing the CLI.
- **Minor (`0.Y+1.0`) when a release changes what a user or a script can
  observe, even if every commit in it is a fix:**
  - where the CLI keeps or reads **user data** — the Chrome profile, sessions,
    downloads — or anything that **migrates** it;
  - a changed **default**, flag meaning, exit code, or output a script parses;
  - anything a user may need to **act on** after upgrading.

  ⚠️ **0.4.14 should have been 0.5.0.** It moved every user's 5 GB Chrome profile
  to a new folder and ran a migration on `launch`. Each commit was honestly a
  fix, which is how it passed as a patch; the rule above looks at the RELEASE,
  not the commit labels. (npm versions are permanent, so it stays 0.4.14.)
- **A genuinely new feature beyond completing the CLI** → minor too. Rare.
- Major → reserved for 1.0 / breaking changes.
- **The version is proposed to the maintainer with a reason and confirmed before
  cutting.** `scripts/release.sh plan` prints what shipped and this checklist.

(History note: `network` shipped as 0.3.1 and `screenshot` as 0.4.0 as *minors* —
that was wrong by this rule; they were gap-fills = patches. Left as-is.)

## Publishing — ONLY on explicit user go-ahead

**Never publish (or bump versions to publish) on your own initiative.**
Default loop while iterating:

1. Make the change in `src/`.
2. `npm run check` (typecheck, port guard, build, `npm test`), then validate against the running Chrome
   by running **`node dist/index.js …`** from the repo. **Do NOT `npm link`** — it
   hijacks the machine-global `browser-automation` bin, so parallel sessions (and
   the user's main session) would run your WIP clone instead of the release. Test
   on a scratch tab you created — never disrupt the user's live tabs.
3. `git commit`, push a branch, open a PR. **This repo allows squash merges only**
   — put every commit's message in the squash body, or the evidence in them is lost.
4. **Tell the user what's merged & unreleased. Wait for an explicit "release"/"publish".**

## Releasing — `scripts/release.sh`

```bash
scripts/release.sh plan                  # what shipped since the last tag + the version checklist
scripts/release.sh cut <patch|minor|X.Y.Z>   # bump both manifests, check, commit onto master, tag, push tag
#   … the maintainer approves the queued run …
scripts/release.sh finish                # wait for CI + the registry, sync the plugin, update this Mac
```

`cut --dry-run` does everything but push, and keeps no tag. The script exists
because each release in 2026-09 was improvised and each hit something the prose
did not say. What it now handles, so you do not have to:

- **Releases are built from `origin/master` in a throwaway worktree.** This
  checkout is shared with other sessions and local `master` is usually checked
  out in another worktree; neither is safe to release from. The push to `master`
  is fast-forward only — if `master` moved, it stops.
- **The plugin marketplace (`../plugins`) is shared with other plugins**, so it is
  routinely behind `origin/main`. `sync-plugin.sh` commits only
  `plugins/browser-automation`, rebases onto `origin/main` and pushes. (0.4.14's
  sync was rejected because a `cctabs` sync had landed first.) `finish` syncs the
  **tag's** files using **this checkout's** script — an old tag's copy lacks fixes.
- **"Published" is read from the registry**, never `npm view`: a successful
  publish is not served for minutes (3.5 for 0.4.13), and `npm view` also caches.

**The approval gate.** Pushing the tag queues the release run behind the
`release` environment, which requires a reviewer. `gh api
…/actions/runs/<id>/pending_deployments -f state=approved` CAN approve it from
here, as the maintainer — so the rule has to be explicit: **approve only when the
maintainer has said to for THIS release** ("release it", "approve it"); otherwise
give them the run link and wait. The gate exists because three versions once
shipped inside forty minutes that nobody approved. The script never approves.

**Downstream, after `finish`** (it prints this too):
- `rememberthis.ai` vendors the skill. There: `python3
  scripts/sync-vendored-skills.py --update`, re-read the `LOCAL` block against
  what changed, commit **that one file** — other sessions work in that repo.
- Tell the maintainer anything a user must act on (a moved profile, a changed default).

**Do NOT `npm publish` from this machine.** It cannot work and it fails
*misleadingly*: the credential in `~/.npmrc` is a GRANULAR token scoped to other
packages, so the PUT comes back **404** — not 403, not "you are not logged in" —
while `npm whoami` and `npm owner ls` keep answering correctly, because they are
unscoped reads. The package publishes from CI via OIDC trusted publishing (no
token, no secret); see the long header in `.github/workflows/release.yml`, which
also warns that **npm trusts that workflow by FILENAME** — renaming it silently
breaks releases.

## Dev gotchas

- **`npm test` locally is meaningless while this user’s Chrome is up, and it is not a regression.**
  Measured 2026-09-17: **61 failing / 12 passing** on `master`, and byte-identically on a PR branch,
  while the same suite is **39/39 green in CI**. The renderer-health tests create and probe real
  targets, so against a busy shared browser on `:9223` they time out — and they open tabs in the
  browser you are working in. `BROWSER_AUTOMATION_PORT` does not isolate them; the failures persist.
  ⇒ **Compare a branch against `master` under the same conditions before believing a red suite**, and
  treat the CI run on the release tag as the authoritative signal. A local red here says nothing.

- The agent shell runs with `set -e -o pipefail` — `grep`/`head` returning
  non-zero (no match, SIGPIPE) aborts a chained script. Keep verification
  `grep`s out of release sequences, or append `|| true`.
- `data:` URLs and `about:`/`blob:` don't take a `https://` prefix — see
  `normalizeUrl` in `src/core/target.ts`.
- gunshi's tokenizer treats an argv element that merely *contains* `--` as an
  option. `src/core/argv.ts` pre-parses argv POSIX-style and hands gunshi a
  canonical form instead; never let raw user text reach gunshi directly.
  `npm test` (black-box, against `dist/`) guards this.

## Key files

- `src/index.ts` — entry (stdout EPIPE-safe).
- `src/commands/*.ts` — one file per subcommand; registered in `src/commands/index.ts`.
- `src/core/cdp.ts` — per-target CDP: connect/eval/navigate/screenshot, `evaluateUntil` auto-wait.
- `src/core/dom.ts` — injected snapshot/click/fill/read JS (pierces shadow DOM + same-origin iframes).
- `src/core/argv.ts` — POSIX pre-parser in front of gunshi (positionals are never re-split; `--` ends options).
- `src/core/resolve.ts` + `args.ts` — tab selection (`-s`/`-m`/`-t`, prefix-matched targetIds).
- `src/core/session.ts` — per-session JSON under `~/.browser-automation/sessions/`.
- `src/core/{download,network}.ts` — download capture + network inspection.
- `skills/browser/SKILL.md` — the Claude Code skill (synced to `generativereality/plugins`).
- `skills/browser/references/*.md` — the skill's long reference material (renderer health,
  input/forms/uploads, contributing), linked from SKILL.md. **SKILL.md stays under 500
  lines** — F-Secure's marketplace skill lint rejects longer ones — so a long new gotcha
  goes in a reference file with a one-paragraph rule and a pointer left in SKILL.md.
  `sync-plugin.sh` ships every file in `references/`.
- `.claude-plugin/plugin.json` — manifest; version must match `package.json`.
