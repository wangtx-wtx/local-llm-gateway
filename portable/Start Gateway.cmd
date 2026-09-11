@echo off
chcp 65001 >nul
set "GATEWAY_HOME=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%GATEWAY_HOME%Start-Gateway.ps1"
if errorlevel 1 pause
