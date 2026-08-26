@echo off
title Darwin Caption Lab
python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4173/api/health', timeout=2).read(1)" >nul 2>&1
if not errorlevel 1 (
  echo O Darwin Caption Lab ja esta aberto. Abrindo a pagina...
  start "" "http://localhost:4173"
  exit /b 0
)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4173'"
for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)"') do set "CAPTION_PYTHON=%%P"
"%CAPTION_PYTHON%" server.py
if errorlevel 1 (
  echo.
  echo Nao foi possivel iniciar. Confirme se o Python esta instalado.
  pause
)
