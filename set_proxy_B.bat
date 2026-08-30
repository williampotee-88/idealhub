@echo off
rem ============================================
rem  [B machine] Enable Windows system proxy -> 127.0.0.1:10800
rem  Prereq: UU remote port mapping active (B:10800 -> A:10800)
rem ============================================
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "http=127.0.0.1:10800;https=127.0.0.1:10800;socks=127.0.0.1:10800" /f >nul
echo System proxy enabled: 127.0.0.1:10800
echo Restart your browser to apply. To disable, run clear_proxy_B.bat
pause
