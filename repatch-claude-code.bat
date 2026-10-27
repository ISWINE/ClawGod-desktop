@echo off
rem Double-click entry: repatch Claude Code with ClawGod patches (auto-discover everything)
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0repatch-claude-code.ps1" %*
echo.
pause
