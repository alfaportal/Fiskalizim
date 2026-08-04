@echo off
cd /d "%~dp0"
echo Duke mbyllur Biznes (port 3971)...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr :3971 ^| findstr LISTENING') do (
  taskkill /PID %%a /F >nul 2>&1
)
echo U mbyll.
timeout /t 2 >nul
