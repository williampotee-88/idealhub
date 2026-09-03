@echo off
REM ============================================================
REM  Stop the A-side proxy gracefully.
REM  1) ask the running instance to exit via its stop API
REM  2) kill any leftover proxyA.exe
REM  3) verify port 10800 is released
REM ============================================================
echo Stopping A-side proxy...

curl -s -X POST --max-time 5 http://127.0.0.1:10801/api/stop >nul 2>&1
timeout /t 2 /nobreak >nul
taskkill /IM proxyA.exe /F >nul 2>&1

netstat -ano | findstr LISTENING | findstr ":10800" >nul
if errorlevel 1 (
  echo [OK] Proxy stopped. Port 10800 is free.
) else (
  echo [WARN] Port 10800 still in use:
  netstat -ano | findstr LISTENING | findstr ":10800"
)
echo.
pause
