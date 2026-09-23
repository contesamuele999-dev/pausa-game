@echo off
chcp 65001 >nul
title Pausa Game - regola firewall

rem Serve i privilegi di amministratore: se non li abbiamo, ci si rilancia da soli
rem e Windows chiede conferma con la finestra blu del Controllo account utente.
net session >nul 2>&1
if errorlevel 1 (
  echo Servono i permessi di amministratore.
  echo Sta per aprirsi la finestra di Windows: premi "Si".
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

echo.
echo Apro la porta 3000 verso la rete locale...
echo.

netsh advfirewall firewall delete rule name="Pausa Game 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Pausa Game 3000" dir=in action=allow protocol=TCP localport=3000 profile=any remoteip=localsubnet
if errorlevel 1 goto :errore

echo.
netsh advfirewall firewall show rule name="Pausa Game 3000" | findstr /C:"Abilitato" /C:"Enabled" /C:"Azione" /C:"Action"
echo.
echo Fatto. La porta 3000 ora accetta i telefoni della tua rete locale
echo (e solo quelli: verso internet resta chiusa).
echo.
echo Ora lancia avvia.bat e riprova dal telefono.
echo.
pause
exit /b 0

:errore
echo.
echo Non sono riuscito ad aggiungere la regola. Leggi l'errore qui sopra.
echo.
pause
exit /b 1
