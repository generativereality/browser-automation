# Testing the pipe broker on the Windows 11 ARM64 guest

What validated 0.7.0 on Windows (2026-10-27, Chrome 156, Node 22): the user's own Chrome
and a login context each on a randomly named pipe, no Chrome TCP listener, `launch`
refusing a Chrome still on the old port and `launch --restart` switching it over, and
the named pipe's ACL. The guest is the qemu VM in `~/VMs/win11` on mbp21; booting it,
console login and the shared-VM rules (snapshot before, revert after) are in the
`windows-dev` skill and in cctabs' `scripts/windows-guest/README.md`.

## ⛔ Do not point USERPROFILE at a test folder

With `USERPROFILE` changed, Chrome cannot find its app-data folder, takes the
`--user-data-dir` for its DEFAULT profile, and refuses DevTools on it ("DevTools remote
debugging requires a non-default data directory") — on the pipe AND on a port. `launch`
then times out, and a port Chrome never listens, so it cannot be quit cleanly. That cost
one full run. Isolate with `BROWSER_AUTOMATION_HOME` and `BROWSER_AUTOMATION_PROFILE`
instead (contexts still land in the real `~\.browser-automation\contexts`, which the
snapshot revert removes). `rawpipe.mjs` is the minimal check: real USERPROFILE answers,
an overridden one does not.

## Run

1. Stage the branch build on the Mac (no plain `npm pack`: `prepack` builds, which is fine
   here, but the tarball's version is whatever package.json says):

   ```sh
   W=<scratch>; npm run build && npm pack --ignore-scripts --pack-destination $W/stage
   (cd $W/stage && echo '{"private":true}' > package.json && npm i --omit=dev --ignore-scripts ./generativereality-browser-automation-*.tgz)
   tar czf $W/ba-stage.tgz -C $W/stage node_modules package.json
   ```
2. Copy `ba-stage.tgz` and these scripts to `C:\Users\dev\ba-test\`, unpack into `stage\`.
   The guest's SSH shell is **PowerShell 5.1: no `&&`**, use `;`.
3. A console session must be logged in (`query user` shows `console … Active`): Chrome is
   started in the desktop session by `run-in-session.ps1` (a one-off scheduled task).
4. `powershell -ExecutionPolicy Bypass -File run-in-session.ps1`, then wait for `DONE` in
   `result.log`.
5. `cleanup.ps1` stops every process whose command line mentions `ba-test` and nothing else.

`Get-Acl` cannot read a named pipe's ACL (error 87); `test.ps1` reads it off a
`NamedPipeClientStream` connection instead.
