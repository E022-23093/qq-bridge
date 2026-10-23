@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping qq-bridge scheduler...
set found=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3199" ^| findstr "LISTENING"') do (
    echo   kill PID %%p
    taskkill /PID %%p /F >nul 2>&1
    set found=1
)
timeout /t 1 /nobreak >nul
if "%found%"=="0" (
    echo   no scheduler found on port 3199.
) else (
    echo   scheduler stopped.
)
echo.
echo (Log: state\scheduler.log)
pause
