# Driving the CLI on Windows

`launch` runs on Windows since 0.4.18 (see Troubleshooting in `SKILL.md`). These are the
traps after that, all measured driving a real site from Git Bash and PowerShell.

## The CLI is installed but `command not found`

The npm global dir holds three shims — `browser-automation`, `.cmd` and `.ps1` — and on a
stock setup the bare name resolves in neither Git Bash nor PowerShell. `command not found`
then reads as "not installed" when it is. The same goes for `pnpm`. Invoke the `.cmd`
through PowerShell:

```powershell
& "$env:APPDATA\npm\browser-automation.cmd" --version
```

## `list` cannot tell you whether a browser is running

With **zero open tabs**, `list` prints the full saved-session list — every row flagged
`[stale]` — and exits 255. That looks exactly like the no-browser case, because `[stale]`
describes a saved session whose tab is gone, not the browser's health. The tell is the
`# open tabs (0)` line at the **end** of the output, easy to miss under a long listing.

⭐ **Ask `launch --status` instead.** It answers in one call (exit 0 = up):

```powershell
& "$env:APPDATA\npm\browser-automation.cmd" launch --status   # Chrome is up on the pipe (\\.\pipe\browser-automation-…)
```

A stale session list plus a browser that is up means **open a tab**
(`new -s [name] [url]`), not relaunch the browser. Since 0.7.0 Chrome on Windows
listens on no port: `http://127.0.0.1:9223/json/version` answering means a Chrome
from before the move, which anything on the computer can drive —
`launch --restart` switches it over.

## `|`, `&` and parentheses break through the `.cmd` shim

`cmd.exe` reads `|` as a pipe, and it appears in ordinary **regex alternation**:
`eval "…match(/(connections|followers)/)…"` dies with `'followers)' is not recognized as an
internal or external command`, which reads as a broken CLI rather than quoting. `&` does
the same, and parentheses or nested quotes in an `eval` expression fail with
`Positional argument 'expr' is required`.

⭐ **The robust pattern is `read` plus host-side parsing**, so no JS crosses the shim:

```powershell
$t = & "$env:APPDATA\npm\browser-automation.cmd" read -s [session] | Out-String
[regex]::Matches($t,'[\d,\.]+K?\s*(?:connections|followers)') | ForEach-Object { $_.Value }
```

When you genuinely need `eval`, write **quote-free JS**: regex literals instead of string
literals, `.join()` with no argument instead of `join("\n")`. `eval` has no `--file`
option, so there is no other escape hatch.

## A global install fails behind a TLS-intercepting proxy

`npm install -g` can fail with `SELF_SIGNED_CERT_IN_CHAIN` or
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` behind a corporate proxy. That is npm's certificate
configuration (`npm config set cafile …`), not this tool. Note that `npm install -g` reads
the **user** `~/.npmrc`, not a project's `.npmrc`, so a registry or CA set only in the
project does not apply to it.
