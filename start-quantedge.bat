@echo off
:: ============================================================
::  QuantEdge — one-click startup
::
::  Boots backend + preview proxy with auto-restart loop.
::  If a process crashes (token expired, network blip, etc.)
::  the loop restarts it within 3 seconds.
::
::  Run from anywhere by double-clicking this file.
:: ============================================================

setlocal
set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
set "LOG_DIR=%ROOT%logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo.
echo  ============================================================
echo   QuantEdge Auto-Boot · %DATE% %TIME%
echo  ============================================================
echo   Backend  : http://localhost:4300
echo   Preview  : http://localhost:5180
echo   Logs     : %LOG_DIR%
echo  ============================================================
echo.

:: Kill any stale node processes first
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

:: Launch backend and preview-proxy in separate persistent windows
:: with auto-restart loops baked in.
start "QuantEdge Backend" cmd /k "cd /d %SERVER_DIR% && :loop && echo [%TIME%] starting backend... && node index.js >> %LOG_DIR%\backend.log 2>&1 && echo [%TIME%] backend died, restart in 3s... && timeout /t 3 /nobreak >nul && goto loop"

timeout /t 2 /nobreak >nul

start "QuantEdge Preview Proxy" cmd /k "cd /d %SERVER_DIR% && :loop && echo [%TIME%] starting proxy... && node preview-proxy.js >> %LOG_DIR%\proxy.log 2>&1 && echo [%TIME%] proxy died, restart in 3s... && timeout /t 3 /nobreak >nul && goto loop"

:: Wait for backend to come up, then open browser
echo Waiting for backend to be ready...
timeout /t 4 /nobreak >nul

:wait_loop
curl -s http://localhost:4300/api/health >nul 2>&1
if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait_loop
)
echo.
echo  Backend is up. Opening browser...
start "" "http://localhost:4300/"

echo.
echo  ============================================================
echo   Both processes are running with auto-restart.
echo   Close those windows to stop them.
echo  ============================================================
echo.
pause
