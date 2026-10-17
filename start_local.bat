@echo off
REM Starts both: the ML API (window 1) and the website (window 2).
start "AquaTrace ML API" cmd /k ""%~dp0run_ml_api_local.bat""
timeout /t 4 >nul
start "AquaTrace website" cmd /k ""%~dp0run_website_local.bat""
