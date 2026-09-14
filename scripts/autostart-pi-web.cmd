@echo off
rem Launches pi-web in production mode, hidden window, logging to .autostart.log.
rem Started by scripts/autostart-pi-web.vbs (registered in Task Scheduler as "pi-web").
setlocal
cd /d "F:\Development\pi-web"

set "LOG=F:\Development\pi-web\.autostart.log"

rem Idempotency guard: skip if something is already listening on 30141.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 30141 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  echo %date% %time% pi-web already running, skipping >> "%LOG%"
  exit /b 0
)

echo %date% %time% starting pi-web >> "%LOG%"
"C:\Program Files\nodejs\node.exe" "F:\Development\pi-web\node_modules\next\dist\bin\next" start -H 127.0.0.1 -p 30141 >> "%LOG%" 2>&1
