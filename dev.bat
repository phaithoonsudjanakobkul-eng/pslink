@echo off
REM PSLink Dev Server launcher
REM   dev.bat              -> HTTPS local + Chrome + DevTools + AUTO-DEPLOY (90s debounce)
REM   dev.bat tunnel       -> above + Cloudflare Tunnel public URL
REM   dev.bat headless     -> no auto-open browser (still auto-deploys)
REM   dev.bat local        -> skip auto-deploy (private edit session, no GitHub push)
cd /d "%~dp0"
if "%1"=="tunnel" (
    node dev-server.js tunnel
) else if "%1"=="headless" (
    node dev-server.js --no-open
) else if "%1"=="local" (
    node dev-server.js --no-deploy
) else (
    node dev-server.js
)
echo.
echo === Dev server exited (code %ERRORLEVEL%) ===
pause
