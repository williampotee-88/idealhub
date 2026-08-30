@echo off
rem -------------------------------------------------------------
rem  Launch ONE app whose traffic goes via A (proxy 127.0.0.1:10800).
rem  The rest of machine B keeps using its own local network.
rem
rem  Usage:
rem    launch_via_A.bat                         -> opens Chrome via A
rem    launch_via_A.bat "X:\path\to\app.exe"    -> opens that app via A
rem
rem  Notes:
rem   - System proxy is NOT changed; only this launched app is routed.
rem   - Chrome/Edge read the --proxy-server flag below.
rem   - Other apps that honor http_proxy / ALL_PROXY env vars will pick
rem     them up automatically from this session.
rem -------------------------------------------------------------
set PORT=10800
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"

if not "%~1"=="" (
  set APP=%~1
  set ARGS=%2 %3 %4 %5 %6 %7 %8 %9
) else (
  set APP=%CHROME%
  set ARGS=--proxy-server="socks5://127.0.0.1:%PORT%"
)

rem Proxy env vars for apps that honor them
set http_proxy=http://127.0.0.1:%PORT%
set https_proxy=http://127.0.0.1:%PORT%
set ALL_PROXY=socks5://127.0.0.1:%PORT%
set socks_proxy=socks5://127.0.0.1:%PORT%

start "" %APP% %ARGS%
