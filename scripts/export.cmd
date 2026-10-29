@echo off
rem Double-click to download the whole block store as JSON.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export.ps1"
pause
