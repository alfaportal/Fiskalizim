@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Vetem per debug — hapet ne shfletues (jo desktop).
echo Per perditim normal perdor START.bat
echo.
where node >nul 2>&1 || (echo Node.js mungon & pause & exit /b 1)
if not exist "node_modules\express" call npm install
start "" "http://127.0.0.1:3971"
node server.js
pause
