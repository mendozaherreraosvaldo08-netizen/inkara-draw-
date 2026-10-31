@echo off
chcp 65001 >nul
title Trazo - crear instalador
echo.
echo  Trazo: preparando el instalador para Windows
echo  (la primera vez descarga Electron y tarda unos minutos)
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Falta Node.js. Instalalo desde https://nodejs.org ^(version 22 o mas nueva^) y vuelve a abrir este archivo.
  pause
  exit /b 1
)
cd /d "%~dp0"
call npm install
if errorlevel 1 goto error
call npm run dist
if errorlevel 1 goto error
echo.
echo  Listo. El instalador esta en la carpeta "release":
dir /b release\*.exe
start "" "release"
pause
exit /b 0
:error
echo.
echo  Algo fallo. Revisa los mensajes de arriba.
pause
exit /b 1
