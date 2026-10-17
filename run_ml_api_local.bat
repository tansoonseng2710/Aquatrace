@echo off
REM AquaTrace ML API on this laptop: http://localhost:7860
REM It tries, in order:
REM   1. FastAPI already installed in your Python
REM   2. the private environment .venv_ml_api (installs FastAPI once; needs internet the first time)
REM   3. basic mode: Python's standard library only, nothing to install
REM All three run the same model and give the same answers. Only FastAPI has the /docs test page.
setlocal
cd /d "%~dp0ml_api"
set "PY="
if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\anaconda3\python.exe" set "PY=%LOCALAPPDATA%\anaconda3\python.exe"
if not defined PY (where py >nul 2>nul && set "PY=py")
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
  echo Python was not found. Install Python 3.10+ or Anaconda, then run this again.
  pause
  exit /b 1
)
set "VENV=%~dp0.venv_ml_api"
set "VPY=%VENV%\Scripts\python.exe"
echo Checking the ML API setup ...

REM 1. FastAPI already in this Python?
"%PY%" -c "import fastapi, uvicorn" >nul 2>nul && (set "RUN=%PY%" & goto fastapi)

REM 2. Private environment that already works?
if exist "%VPY%" "%VPY%" -c "import fastapi, uvicorn" >nul 2>nul && (set "RUN=%VPY%" & goto fastapi)

REM 3. Build (or rebuild) the private environment and install FastAPI once.
REM    --clear empties only .venv_ml_api, the throw-away folder this script made, if an earlier try broke off.
echo Installing FastAPI into .venv_ml_api (first time only, needs internet, about 1 minute) ...
"%PY%" -m venv --clear "%VENV%" && "%VPY%" -m pip install --disable-pip-version-check -q -r requirements.txt && (set "RUN=%VPY%" & goto fastapi)
echo.
echo FastAPI could not be installed (no internet, or Python's venv/pip is not working).
echo Starting in basic mode instead: same model, same answers, nothing to install.
goto basic

:fastapi
echo.
echo  AquaTrace ML API: http://localhost:7860    (test page: http://localhost:7860/docs)
echo  Keep this window open. Press Ctrl+C to stop.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:7860/docs"
"%RUN%" -m uvicorn app:app --host 127.0.0.1 --port 7860
echo.
echo The ML API stopped. If you see "address already in use", it is already running in another window.
pause
exit /b

:basic
echo.
echo  AquaTrace ML API (basic mode): http://localhost:7860
echo  Keep this window open. Press Ctrl+C to stop.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:7860/health"
"%PY%" serve_basic.py 7860
echo.
echo The ML API stopped. If you see "address already in use", it is already running in another window.
pause
