@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo ERROR: Python environment .venv was not found.
    echo Run INSTALL_WINDOWS.bat first.
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -c "import uvicorn, cv2, fastapi, multipart"
if errorlevel 1 (
    echo ERROR: Required Python packages are missing.
    echo Run INSTALL_WINDOWS.bat first.
    pause
    exit /b 1
)

cd /d "%~dp0server"
echo Open this URL on the computer: http://localhost:8000/track/
echo Stop server with Ctrl+C.
"..\.venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8000

echo Server has stopped.
pause
