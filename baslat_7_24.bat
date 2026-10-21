@echo off
title AltcoinAutoTrader v9.2 - 7/24 Otonom Zirh Modu
cd /d "c:\Users\berke\Documents\GitHub\altcoin-news-hunter"
:loop
echo [%date% %time%] AltcoinAutoTrader 7/24 Otonom Motor baslatiliyor...
"C:\Users\berke\.gemini\antigravity\brain\6a17d182-96a6-4ce0-b65c-3dee808fc2fe\scratch\node\node-v22.11.0-win-x64\node.exe" altcoin_auto_trader.mjs --daemon
echo [%date% %time%] Motor yeniden baslatiliyor (5 saniye)...
timeout /t 5 /nobreak >nul
goto loop
