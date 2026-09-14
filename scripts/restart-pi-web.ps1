# restart-pi-web.ps1 — restart pi-web from inside a pi-web-hosted session, safely.
#
# WHY THIS EXISTS
# An agent session runs INSIDE pi-web. When that agent restarts the server, it kills its own
# host — and whatever it was going to do next dies with it. That is how a restart turns into a
# dead screen and a lost session: the kill and the restart were the SAME process tree.
#
# THE FIX is detachment. A separate process is spawned FIRST, and it is that child — not the
# caller — which stops the old server and starts the new one, waits for it to answer, and
# writes a log. The child survives the parent's death (verified: a detached Start-Process
# child completes after its parent shell exits), so the restart always finishes even though the
# session that asked for it is gone.
#
# The caller returns immediately. The session MAY be interrupted — that is inherent, a restart
# kills it) -- but the server comes back without help, and the -Status flag reports it.
#
# USAGE
#   powershell -File scripts\restart-pi-web.ps1              # detached restart, returns at once
#   powershell -File scripts\restart-pi-web.ps1 -Wait        # run in the foreground and watch
#   powershell -File scripts/restart-pi-web.ps1 -Status    # read the last run log
#
# LOG: logs\pi-web-restart.log (appended, so history survives across restarts)

[CmdletBinding()]
param(
  [switch]$Wait,
  [switch]$Status,
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$LogDir     = Join-Path $ProjectDir "logs"
$LogFile    = Join-Path $LogDir "pi-web-restart.log"
$Port       = 30141
$Url        = "http://127.0.0.1:$Port"
$NodeExe    = "C:\Program Files\nodejs\node.exe"

# --- -Status: report the last run without touching anything ------------------------------
if ($Status) {
  if (-not (Test-Path $LogFile)) { Write-Output "no restart log yet at $LogFile"; exit 0 }
  Write-Output ("--- tail of " + $LogFile + " ---")
  Get-Content $LogFile -Tail 40
  exit 0
}

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  $line  = "$stamp  $Message"
  if ($Wait) { Write-Host $line }
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Test-PiWeb {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch { return $false }
}

function Get-ListenerPid {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
          Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

# --- the restart body, run either detached (default) or in the foreground ------------------
function Invoke-Restart {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  $mode = if ($Wait) { "foreground" } else { "detached" }
  Write-Log "restart requested (pid $PID, mode $mode)"

  # 1. stop the old server, whole tree (/T): without it the child node process survives and
  #    keeps holding the port (GL-020).
  $oldPid = Get-ListenerPid
  if ($oldPid) {
    Write-Log "stopping pid $oldPid (tree)"
    & taskkill /PID $oldPid /T /F 2>&1 | ForEach-Object { Write-Log "  $_" }
  } else {
    Write-Log "nothing listening on $Port — nothing to stop"
  }

  # 2. wait for the port to actually free before binding again
  $freed = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-ListenerPid)) { $freed = $true; break }
  }
  Write-Log $(if ($freed) { "port $Port released" } else { "WARNING: port $Port still bound after 15s" })

  # 3. start the new server
  Write-Log "starting pi-web"
  Start-Process -FilePath $NodeExe `
    -ArgumentList (Join-Path $ProjectDir "node_modules\next\dist\bin\next"), "start", "-H", "127.0.0.1", "-p", "$Port" `
    -WorkingDirectory $ProjectDir -WindowStyle Hidden

  # 4. WAIT FOR HEALTH — this is the step whose absence left a dead screen. A process that
  #    spawned is not a server that serves.
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-PiWeb) { $ok = $true; break }
  }

  if ($ok) {
    $newPid = Get-ListenerPid
    $took = [int]$TimeoutSeconds
    Write-Log "HEALTHY — $Url (pid $newPid) [waited up to $took seconds]"
  } else {
    Write-Log "FAILED: $Url did not answer within $TimeoutSeconds seconds — server is DOWN"
  }
}

if ($Wait) {
  Invoke-Restart
} else {
  # Detach: a separate process does the work, so it outlives the session that called us.
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  Add-Content -Path $LogFile -Value "" -Encoding UTF8
  $self = $MyInvocation.MyCommand.Path
  Start-Process -FilePath "powershell" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $self, "-Wait", "-TimeoutSeconds", $TimeoutSeconds `
    -WindowStyle Hidden
  Write-Output "restart detached — it will complete without this session."
  Write-Output "check progress:  powershell -File scripts\restart-pi-web.ps1 -Status"
}
