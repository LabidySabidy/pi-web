@echo off
rem Launch pi-omni with output continuously logged to logs\pi-omni*.log.
rem
rem A wrapper .cmd is used rather than passing the node path through
rem Start-Process -ArgumentList: "C:\Users\Kasim Alam\..." contains a space, and
rem an unquoted path there splits at the space, producing
rem   Error: Cannot find module 'C:\Users\Kasim'
rem Keeping the path inside a batch file avoids every layer of that quoting.
rem
rem stderr carries pi-omni's transcript log (every user turn and assistant
rem answer), which is where the model-side failures are visible. stdout carries
rem the base_url= handshake.

cd /d "%~dp0.."

set "PI_OMNI_BIN=%APPDATA%\..\..\..\Users\%USERNAME%\.npm-global\node_modules\@khimaros\pi-omni\dist\server\index.js"
if not exist "%PI_OMNI_BIN%" (
  for /f "delims=" %%i in ('npm root -g') do set "PI_OMNI_BIN=%%i\@khimaros\pi-omni\dist\server\index.js"
)

echo [%date% %time%] starting pi-omni >> logs\pi-omni.out.log
node "%PI_OMNI_BIN%" --listen 127.0.0.1:4962 1>> logs\pi-omni.out.log 2>> logs\pi-omni.log
echo [%date% %time%] pi-omni exited with %ERRORLEVEL% >> logs\pi-omni.out.log
