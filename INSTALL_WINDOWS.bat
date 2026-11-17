@echo off
setlocal
cd /d "%~dp0"
echo WebAR OpenCV: Python environment setup

where py >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python Launcher was not found.
    echo Install Python 3.12 x64, then reopen this window.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    py -3.12 -m venv .venv
    if errorlevel 1 (
        echo ERROR: Failed to create .venv.
        pause
        exit /b 1
    )
)

echo Installing packages: FastAPI, OpenCV, Uvicorn...
".venv\Scripts\python.exe" -m pip --isolated install -r "server\requirements.txt"
if errorlevel 1 (
    echo ERROR: Package installation failed.
    echo Check Internet connection and Python package index access.
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -c "import uvicorn, cv2, fastapi, multipart"
if errorlevel 1 (
    echo ERROR: Package import check failed.
    pause
    exit /b 1
)

echo Setup complete. Run START_WINDOWS.bat.
pause
