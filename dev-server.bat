@echo off
title FACEIT+ dev server
cd /d "%~dp0"
:loop
echo [%date% %time%] demarrage de wxt... >> "%~dp0wxt-dev.log"
call npm run dev >> "%~dp0wxt-dev.log" 2>&1
echo [%date% %time%] wxt s'est arrete, relance dans 2s... >> "%~dp0wxt-dev.log"
timeout /t 2 /nobreak >nul
goto loop
