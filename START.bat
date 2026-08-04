@echo off
chcp 65001 >nul
title Biznes — Test ATK / SEF
cd /d "%~dp0"

echo.
echo  === Biznes — Test ATK / SEF ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [GABIM] Node.js nuk u gjet.
  echo Instalo nga https://nodejs.org ^(LTS^) pastaj provo perseri.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo Duke instaluar paketat...
  call npm install
  if errorlevel 1 (
    echo [GABIM] npm install deshtoi.
    pause
    exit /b 1
  )
)

REM Liro portin 3971 nese eshte i zene
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr :3971 ^| findstr LISTENING') do (
  taskkill /PID %%a /F >nul 2>&1
)

echo Duke nisur serverin lokal...
start "Biznes-Server" /MIN cmd /c "cd /d ""%~dp0"" && node server.js"

REM Prit derisa serveri te jete gati
set /a tries=0
:waitloop
set /a tries+=1
if %tries% GTR 40 (
  echo [GABIM] Serveri nuk u nis. Shiko dritaren Biznes-Server.
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3971/api/health -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)

echo Duke hapur dritaren e aplikacionit...

REM Prefero dritare app (pa shirit browser) — Edge, pastaj Chrome, pastaj browser normal
set "APPURL=http://127.0.0.1:3971"

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%APPURL%" --new-window
  goto done
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app="%APPURL%" --new-window
  goto done
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%APPURL%" --new-window
  goto done
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" --app="%APPURL%" --new-window
  goto done
)

start "" "%APPURL%"

:done
echo.
echo  U hap. Mbaje dritaren e vogël "Biznes-Server" hapur sa te punosh.
echo  Nese nuk e sheh dritaren e app-it, hap: %APPURL%
echo.
timeout /t 4 /nobreak >nul
exit /b 0
