@echo off
rem =============================================================
rem  Open a browser whose traffic goes via A (proxy 127.0.0.1:10800).
rem  Every other app on B keeps using B's OWN local network.
rem
rem  IMPORTANT: Do NOT enable system-wide proxy (set_proxy_B.bat
rem  or the HTA "open" button). Leave system proxy OFF so that
rem  only this browser is routed through A.
rem
rem  Usage:
rem    browser_via_A.bat          -> opens Chrome via A (default)
rem    browser_via_A.bat edge     -> opens Microsoft Edge via A
rem    browser_via_A.bat firefox  -> opens Firefox via A
rem =============================================================
set PORT=10800
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
set EDGE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set FFOX="C:\Program Files\Mozilla Firefox\firefox.exe"

if /i "%~1"=="edge" goto EDGE
if /i "%~1"=="firefox" goto FFOX

rem ---- default: Chrome, isolated profile so the proxy flag is honored ----
if exist %CHROME% (
  start "" %CHROME% --proxy-server="socks5://127.0.0.1:%PORT%" --user-data-dir="%TEMP%\browser_via_A"
  goto END
)
if exist %EDGE% (
  start "" %EDGE% --proxy-server="socks5://127.0.0.1:%PORT%" --user-data-dir="%TEMP%\browser_via_A_edge"
  goto END
)
echo ERROR: Chrome not found. Try "browser_via_A.bat edge" or set CHROME path above.
pause
goto END

:EDGE
if exist %EDGE% (
  start "" %EDGE% --proxy-server="socks5://127.0.0.1:%PORT%" --user-data-dir="%TEMP%\browser_via_A_edge"
) else (
  echo ERROR: Microsoft Edge not found.
  pause
)
goto END

:FFOX
if exist %FFOX% (
  rem Firefox ignores --proxy-server; use a dedicated profile set to SOCKS5.
  start "" %FFOX% -no-remote -profile "%TEMP%\browser_via_A_ff"
) else (
  echo ERROR: Firefox not found.
  pause
)
goto END

:END
