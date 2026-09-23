# Hit a shortcoming or bug? Fix it — it's open source

Reference for the `browser` skill. Read it when the CLI cannot do something a site needs,
or misbehaves, and you are about to work around it.

This CLI is `@generativereality/browser-automation` (repo:
`github.com/generativereality/browser-automation`). When you hit a missing
capability or a bug (a site needs something the CLI can't do yet, an export
won't trigger, a selector strategy fails), **fix it at the source rather than
working around it forever**:

1. **Clone** next to your work: `gh repo clone generativereality/browser-automation`
   (or `git clone https://github.com/generativereality/browser-automation`).
2. **Fix** in `src/` — TypeScript. Commands live in `src/commands/<name>.ts`,
   the daemonless CDP core in `src/core/` (`cdp.ts` connection/eval/navigate,
   `dom.ts` injected snapshot/click/read JS, `download.ts`, `resolve.ts` tab
   selection). Add a command by creating `src/commands/x.ts` and registering it
   in `src/commands/index.ts`.
3. **Validate locally** against the running Chrome:
   `npm install && npm run typecheck && npm run build`, then run your build as
   **`node dist/index.js <cmd>`** from the clone. **Do NOT `npm link`** — it
   repoints the machine-global `browser-automation` bin, so a parallel Claude
   Code session (or the user's main session) would suddenly be running *your*
   work-in-progress clone instead of the installed release. Validate via the
   explicit `node dist/index.js` path instead. Reproduce the failure, confirm
   the fix, and re-test on a scratch tab you created (read-only-safe; never
   disrupt the user's live tabs).
4. **Propose a PR** for the user to review and contribute upstream — don't
   publish yourself (the maintainer cuts releases):
   ```bash
   git checkout -b fix/<short-desc>
   git commit -am "fix: <what and why>"
   gh pr create --fill --repo generativereality/browser-automation
   ```
   Then tell the user the branch/PR link and what it changes, and ask them to
   review and merge. After it's released, `npm install -g @generativereality/browser-automation@latest`.
