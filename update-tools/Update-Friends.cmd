@echo off
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Update-Friends.ps1"
if errorlevel 1 pause
