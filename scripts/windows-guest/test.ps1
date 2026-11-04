# browser-automation pipe broker on Windows, run in the desktop session (scheduled task).
# The user's own Chrome lives under C:\Users\dev\ba-test (BROWSER_AUTOMATION_HOME, _PROFILE,
# a port of its own). USERPROFILE stays real: pointed elsewhere, Chrome refuses DevTools.
$ErrorActionPreference = 'Continue'
$T = 'C:\Users\dev\ba-test'
$log = "$T\result.log"
$env:BROWSER_AUTOMATION_HOME = "$T\home\.browser-automation"; $env:BROWSER_AUTOMATION_PROFILE = "$T\profile"
$env:BROWSER_AUTOMATION_PORT = '40123'; $env:NO_UPDATE_NOTIFIER = '1'; $env:NO_COLOR = '1'
Remove-Item Env:BROWSER_AUTOMATION_CDP -ErrorAction SilentlyContinue
Remove-Item Env:BAC_CONTEXT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$T\home" | Out-Null
$node = 'C:\Users\dev\node\node.exe'
$ba = "$T\stage\node_modules\@generativereality\browser-automation\dist\index.js"
function BA { param([Parameter(ValueFromRemainingArguments = $true)]$a) "`n>>> ba $($a -join ' ')"; & $node $ba @a 2>&1 | ForEach-Object { "$_" }; "<<< exit $LASTEXITCODE" }
function ChromeListens {
  $ids = @((Get-Process chrome -ErrorAction SilentlyContinue).Id)
  $l = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess }
  "chrome processes: $($ids.Count); chrome TCP listeners: [" + (($l | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ', ') + "]"
}
function PipeAcl($stateFile) {
  $s = (Get-Content $stateFile | ConvertFrom-Json).socket; "pipe: $s"
  try {
    $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $s.Substring('\\.\pipe\'.Length), [System.IO.Pipes.PipeDirection]::InOut)
    $c.Connect(3000)
    $c.GetAccessControl().Access | ForEach-Object { "  $($_.IdentityReference) $($_.AccessControlType) $($_.PipeAccessRights)" }
    $c.Dispose()
  } catch { "  acl: $_" }
}
& {
  "=== 1. an old Chrome on the port, same profile"
  $chrome = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  New-Item -ItemType Directory -Force "$T\profile" | Out-Null
  Start-Process $chrome -ArgumentList "--remote-debugging-port=40123", "--user-data-dir=$T\profile", "--no-first-run", "--no-default-browser-check", "about:blank" | Out-Null
  Start-Sleep 8
  ChromeListens
  BA launch
  BA launch --restart
  ChromeListens
  "=== 2. own Chrome on the pipe"
  Get-Content "$T\home\.browser-automation\broker.json"
  BA launch --status
  BA new -s t1 "data:text/html,<h1>pipe-ok</h1>"
  BA eval -s t1 "document.querySelector('h1').textContent"
  BA doctor
  "=== 3. a login context"
  BA new -s c1 --context bapipe "data:text/html,<h1>context-ok</h1>"
  BA eval -s c1 "document.querySelector('h1').textContent"
  Get-Content "C:\Users\dev\.browser-automation\contexts\bapipe\broker.json"
  BA context
  ChromeListens
  "=== 4. pipe ACLs"
  PipeAcl "$T\home\.browser-automation\broker.json"
  PipeAcl "C:\Users\dev\.browser-automation\contexts\bapipe\broker.json"
  "=== 5. stop the context"
  BA context stop bapipe
  Start-Sleep 6
  BA context
  "DONE"
} *>> $log
