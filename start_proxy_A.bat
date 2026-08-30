@echo off
cd /d "%~dp0"

REM ---- 1. check python in PATH ----
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] python command not found.
    echo Reason: Python is not installed, or not added to PATH.
    echo Fix: Download from https://www.python.org and check
    echo       "Add python.exe to PATH" during install, then rerun.
    echo.
    pause
    exit /b 1
)

REM ---- 2. start proxy ----
echo Starting A-side proxy at 127.0.0.1:10800 ...
echo Keep this window open. Close it to stop the proxy.
echo If a red error appears below, screenshot it; the window stays open.
echo.
python dual_proxy.py --port 10800

REM ---- 3. on abnormal exit, give hints ----
echo.
echo [INFO] proxy exited, exitcode=%errorlevel%
if %errorlevel% neq 0 (
    echo Common causes:
    echo   1) Port 10800 in use -> use another port:
    echo      python dual_proxy.py --port 1080
    echo      (check usage: netstat -ano ^| findstr 10800)
    echo   2) A leftover python process from last time may hold the port.
)
echo.
pause
