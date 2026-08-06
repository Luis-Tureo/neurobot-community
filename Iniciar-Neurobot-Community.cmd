@echo off
setlocal
cd /d "%~dp0"
title Neurobot Community
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-community.ps1"
if errorlevel 1 (
  echo.
  echo Neurobot Community no pudo iniciarse. Revisa el error mostrado arriba.
)
echo.
pause
endlocal
