# Registers pi-web to start at user logon (hidden, no console window).
#
# Re-run after moving the checkout, or after a Windows "Reset this PC".
# Remove the task with:
#   Unregister-ScheduledTask -TaskName "pi-web" -Confirm:$false
#   Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"  (no-op, not used)

$ErrorActionPreference = "Stop"

$projectDir = "F:\Development\pi-web"
$taskName   = "pi-web"
$user       = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name  # e.g. DESKTOP-ABC\Kasim Alam
$vbsPath    = Join-Path $projectDir "scripts\autostart-pi-web.vbs"

if (-not (Test-Path $vbsPath)) {
  throw "Launcher not found: $vbsPath"
}

$action    = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbsPath + '"')
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
  -Description "Start pi-web (http://127.0.0.1:30141) at logon" -Force | Out-Null

Write-Host "Registered task '$taskName' (at logon, user: $user)"
