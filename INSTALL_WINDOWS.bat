@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo === WebAR OpenCV: подготовка ===
where py >nul 2>&1
if errorlevel 1 (
  echo Python Launcher не найден. Установи Python 3.12 x64.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv
  if errorlevel 1 (
    echo Не удалось создать виртуальное окружение.
    pause
    exit /b 1
  )
)
echo Устанавливаем FastAPI, OpenCV, Uvicorn...
".venv\Scripts\python.exe" -m pip --isolated install -r "server\requirements.txt"
if errorlevel 1 (
  echo Не удалось установить зависимости. Проверь доступ к pypi.org.
  echo При ошибке ProxyError проверь сетевые настройки, прокси/VPN.
  pause
  exit /b 1
)
echo Установка готова. Теперь запускай START_WINDOWS.bat
pause
