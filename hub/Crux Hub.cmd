@echo off
rem Opens the Crux hub at http://localhost:4747, starting it first if it is not running.
rem Projects come from %USERPROFILE%\crux\hub.json  ({ "projects": ["C:/path/to/project", ...] }).
rem The hub keeps running in a minimized window; close that window to stop it.
curl -sf -o nul -m 2 http://localhost:4747/api/ping
if errorlevel 1 (
  start "Crux Hub" /min cmd /c node "%~dp0server.mjs"
  timeout /t 3 /nobreak >nul
)
start "" http://localhost:4747/
