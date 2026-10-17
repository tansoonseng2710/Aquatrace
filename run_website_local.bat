@echo off
REM AquaTrace website on this laptop: http://localhost:5500
setlocal
cd /d "%~dp0frontend"
set "PY="
if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"
if not defined PY (where py >nul 2>nul && set "PY=py")
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
  echo Python was not found. You can still open frontend\index.html by double-clicking it.
  pause
  exit /b 1
)
echo.
echo  AquaTrace website: http://localhost:5500
echo  Keep this window open. Press Ctrl+C to stop.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:5500/index.html#ml"
"%PY%" -m http.server 5500 --bind 127.0.0.1
pause
