@echo off
setlocal
cd /d "%~dp0"
title Instalar Neurobot Community
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install-community.ps1"
if errorlevel 1 (
  echo.
  echo La instalacion no se completo. Revisa el error mostrado arriba.
)
echo.
pause
endlocal
