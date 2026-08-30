@echo off
rem ============================================================
rem  Build a standalone Windows exe of the A-side proxy.
rem  No Python needed on the target machine (C) to run the exe.
rem  Requires: Python 3.7+ here, and network to pip install.
rem ============================================================
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] python not found. Install Python and check "Add to PATH".
  pause
  exit /b 1
)

echo Installing / upgrading PyInstaller ...
python -m pip install --upgrade pyinstaller
if %errorlevel% neq 0 (
  echo [ERROR] pip install pyinstaller failed (no network?).
  pause
  exit /b 1
)

echo Building exe (this may take a minute) ...
pyinstaller --onefile --noconsole --name proxyA proxy_A_app.py
if %errorlevel% neq 0 (
  echo [ERROR] pyinstaller build failed.
  pause
  exit /b 1
)

echo.
echo Build done. The exe is at: dist\proxyA.exe
echo Copy proxyA.exe to machine C (no Python needed there).
echo.
pause
