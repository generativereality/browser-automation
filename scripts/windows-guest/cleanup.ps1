# Stop only what the ba-test run started: processes whose command line mentions ba-test.
$mine = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'ba-test' -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch 'cleanup\.ps1' }
foreach ($p in $mine) { "stop $($p.ProcessId) $($p.Name)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2
"left: " + @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ba-test' -and $_.CommandLine -notmatch 'cleanup\.ps1' }).Count
