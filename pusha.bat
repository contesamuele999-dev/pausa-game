@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pausa Game - push su GitHub

set REPO=pausa-game

where git >nul 2>&1 || (echo Serve Git: https://git-scm.com & pause & exit /b 1)
where gh  >nul 2>&1 || (echo Serve GitHub CLI: https://cli.github.com & pause & exit /b 1)
gh auth status >nul 2>&1 || (echo Non sei loggato. Lancia: gh auth login & pause & exit /b 1)

if not exist .git (
  echo Prima volta: creo il repository locale...
  git init -b main || goto :errore
)

set MSG=
set /p MSG=Messaggio del commit (invio = "aggiornamenti"):
if "%MSG%"=="" set MSG=aggiornamenti

git add -A || goto :errore
git diff --cached --quiet && (
  echo Niente da committare.
) || (
  git commit -m "%MSG%" || goto :errore
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo Creo il repository %REPO% su GitHub, privato...
  gh repo create %REPO% --private --source=. --remote=origin --push || goto :errore
) else (
  git push -u origin main || goto :errore
)

echo.
echo Fatto.
gh repo view --json url --jq .url
echo.
pause
exit /b 0

:errore
echo.
echo Qualcosa e' andato storto, leggi l'errore qui sopra.
pause
exit /b 1
