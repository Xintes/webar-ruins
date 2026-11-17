@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Нет виртуального окружения. Сначала запусти INSTALL_WINDOWS.bat
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -c "import uvicorn, cv2, fastapi, multipart"
if errorlevel 1 (
  echo Не хватает Python-зависимостей. Сначала запусти INSTALL_WINDOWS.bat
  pause
  exit /b 1
)
cd server
echo Открой на ПК: http://localhost:8000/track/
echo Для остановки сервера: Ctrl+C
"..\.venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8000
pause
