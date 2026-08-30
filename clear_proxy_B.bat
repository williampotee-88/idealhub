@echo off
rem ============================================
rem  [B machine] Disable Windows system proxy (restore B's own network)
rem ============================================
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
echo System proxy disabled.
echo Restart your browser to apply.
pause
