@echo off
REM ============================================================
REM  List the terminals (B machines) currently borrowing A's network.
REM  Reads http://127.0.0.1:10801/api/clients from the running proxy.
REM  Requires A to run dual_proxy.py / proxyA.exe v1.3+ and the B-side
REM  browser extension v1.3+ (which reports its terminal name).
REM ============================================================
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:10801/api/clients' -TimeoutSec 5; Write-Host ('Online: ' + $r.clients_online + ' of ' + $r.clients.Count + ' terminal(s)') -ForegroundColor Green; if ($r.clients.Count -eq 0) { Write-Host 'No terminal has reported yet.' -ForegroundColor Yellow } else { $r.clients | Select-Object @{n='Name';e={$_.name}}, @{n='SourceIP';e={$_.ip}}, @{n='State';e={if($_.online){'ONLINE'}else{'offline'}}}, @{n='ConnectedFor';e={$_.since}}, @{n='IdleSec';e={$_.idle}}, @{n='Conn5m';e={$_.conns5m}} | Format-Table -AutoSize } } catch { Write-Host 'Cannot reach A proxy panel on 10801. Is proxyA.exe running?' -ForegroundColor Red }"
echo.
pause
