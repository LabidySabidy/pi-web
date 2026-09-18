@echo off
rem Dev server for the Live Conversation probe, on an isolated port.
rem
rem Production pi-web occupies 30141 with `next start`, so this must not bind
rem there. Invokes next directly instead of `npm run dev`, because that script
rem hardcodes -p 30141.
rem
rem Logs: logs/dev-30142.log (appended). Turbopack writes its own diagnostics to
rem stdout, and the server's request log goes to stderr -- both are captured so
rem a fetch of /vad/silero_vad_v5.bin is visible as it happens.

cd /d "%~dp0.."
set "NODE_OPTIONS=--no-warnings"
echo. >> logs\dev-30142.log
echo ===== dev start %date% %time% ===== >> logs\dev-30142.log
node node_modules\next\dist\bin\next dev -H 127.0.0.1 -p 30142 1>> logs\dev-30142.log 2>&1
echo ===== dev exited %date% %time% (code %ERRORLEVEL%) ===== >> logs\dev-30142.log
