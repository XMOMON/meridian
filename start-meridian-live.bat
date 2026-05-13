@echo off
title Meridian - LIVE Trading ($15 Micro)
color 0C
echo ========================================
echo   WARNING: LIVE TRADING MODE
echo   Real SOL will be deployed!
echo ========================================
echo.
echo   Deploy: 0.05 SOL per position
echo   Max positions: 1
echo   Stop loss: -15%%
echo   Take profit: 8%%+ trailing
echo.
echo   Press any key to start...
echo   Press Ctrl+C to cancel.
pause >nul
echo.
echo Switching to live config...
cd /d C:\Users\Administrator\Downloads\meridian
copy /Y user-config-live.json user-config.json >nul
echo Live config loaded. Starting agent...
echo.
node index.js
pause
