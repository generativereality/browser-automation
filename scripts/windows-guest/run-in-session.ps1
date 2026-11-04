# Run test.ps1 in the logged-in desktop session (a GUI started over SSH is invisible).
$ProgressPreference = 'SilentlyContinue'
$name = 'ba-pipe-test'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\dev\ba-test\test.ps1'
$p = New-ScheduledTaskPrincipal -UserId 'dev' -LogonType Interactive
Register-ScheduledTask -TaskName $name -Action $a -Principal $p -Force | Out-Null
try { Start-ScheduledTask -TaskName $name } finally { Start-Sleep 2; Unregister-ScheduledTask -TaskName $name -Confirm:$false }
'started'
