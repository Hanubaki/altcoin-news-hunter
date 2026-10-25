@echo off
chcp 65001 >nul
title 7/24 Altcoin Spot (3847) + Kaldirac 3x-5x (3848) + Mobil Tunel Komuta Merkezi
cd /d "%~dp0"

echo ============================================================================
echo [1/4] Windows Uyku Modu Korumasi Aktif Ediliyor (Fise Takiliyken Asla Uyuma)...
echo ============================================================================
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1

set "NODE_BIN=C:\Users\berke\.gemini\antigravity\brain\6a17d182-96a6-4ce0-b65c-3dee808fc2fe\scratch\node\node-v22.11.0-win-x64\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

set "CF_BIN=C:\Users\berke\.gemini\antigravity\brain\b9782ae6-c69c-48d9-9db1-3135f76f8ff0\scratch\cloudflared.exe"

echo [2/4] Binance TR Spot Botu (Port 3847) Kontrol Ediliyor...
netstat -ano | findstr ":3847 " | findstr "LISTENING" >nul
if %errorlevel% neq 0 (
    echo    -^> Spot Bot baslatiliyor...
    start "BinanceTR-Spot-Bot-3847" /min "%NODE_BIN%" altcoin_auto_trader.mjs --daemon
) else (
    echo    -^> Spot Bot zaten aktif (Port 3847).
)

echo [3/4] Kaldirac 3x-5x Vadeli Botu (Port 3848) Kontrol Ediliyor...
netstat -ano | findstr ":3848 " | findstr "LISTENING" >nul
if %errorlevel% neq 0 (
    echo    -^> Kaldirac Botu baslatiliyor...
    start "Kaldirac-3x5x-Bot-3848" /min "%NODE_BIN%" leverage-3x-system/leverage_3x_trader.mjs --daemon
) else (
    echo    -^> Kaldirac Botu zaten aktif (Port 3848).
)

echo [4/4] 4.5G/Mobil Cloudflare HTTPS Tuneli Kontrol Ediliyor...
tasklist /FI "IMAGENAME eq cloudflared.exe" 2>NUL | find /I /N "cloudflared.exe">NUL
if %errorlevel% neq 0 (
    if exist "%CF_BIN%" (
        echo    -^> Cloudflare Mobil HTTPS Tuneli baslatiliyor...
        start "Cloudflare-Mobil-Tunel-3848" /min cmd /c "\"%CF_BIN%\" tunnel --url http://127.0.0.1:3848 --no-autoupdate > leverage-3x-system\.cloudflared_tunnel.log 2>&1"
    )
) else (
    echo    -^> Cloudflare Mobil Tuneli zaten aktif.
)

echo.
echo ============================================================================
echo TUM SISTEMLER 7/24 AKTIF!
echo   - Bilgisayar Paneli : http://localhost:3848
echo   - Ev Wi-Fi Paneli   : http://192.168.1.101:3848
echo   - Yeni Mobil Link olustugunda otomatik KALDIRAC_3X_RAPOR.md ve WhatsApp'a duser!
echo ============================================================================
timeout /t 5
