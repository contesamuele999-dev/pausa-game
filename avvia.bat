@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pausa Game

if not exist node_modules (
  echo Prima installazione, attendi...
  call npm install --no-fund --no-audit || goto :errore
)

rem IP del portatile sulla rete locale: serve perche' il QR deve puntare qui, non a localhost
set IP=
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration).Where({ $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' })[0].IPv4Address.IPAddress"`) do set IP=%%i
if "%IP%"=="" set IP=localhost

set PUBLIC_URL=http://%IP%:3000
echo.
echo   Schermo (proiettore) : http://localhost:3000/host
echo   Telefoni in sala     : %PUBLIC_URL%
echo.
echo   I telefoni devono stare sulla stessa wifi del portatile.
echo   Chiudi la finestra "Pausa Game - server" per fermare tutto.
echo.

start "Pausa Game - server" cmd /k "npm start"
timeout /t 4 >nul
start "" "http://localhost:3000/host"
exit /b 0

:errore
echo.
echo Installazione fallita. Serve Node.js: https://nodejs.org
pause
exit /b 1
