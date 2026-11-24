@echo off
setlocal
set "FRIENDS_ELECTRON=%~dp0runtime\electron.exe"
if not exist "%FRIENDS_ELECTRON%" set "FRIENDS_ELECTRON=%~dp0..\friends-desktop-v2\runtime\electron.exe"
if not exist "%FRIENDS_ELECTRON%" (
  echo The desktop runtime was not found.
  pause
  exit /b 1
)
start "" "%FRIENDS_ELECTRON%" "%~dp0." --local-preview
