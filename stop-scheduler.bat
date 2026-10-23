@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping qq-bridge scheduler...
set found=0
rem 只匹配 ":3199 " （端口后面必须跟空格），否则 findstr 的子串匹配会把 :31990 之类也杀掉。
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":3199 " ^| findstr "LISTENING"') do (
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
