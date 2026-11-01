@echo off
setlocal
title Shelfie - your personal library
cd /d "%~dp0"

echo.
echo   ==================================================
echo      Shelfie - your personal library
echo   ==================================================
echo.

rem ---------- 1. Find Python 3.10 or newer ----------
:findpython
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
rem a freshly installed Python may not be on PATH in this window yet, so also look where installers put it
if not defined PY for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%D\python.exe" set PY="%%D\python.exe"
if not defined PY if defined JUST_INSTALLED goto :restartneeded
if not defined PY goto :nopython
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1 || goto :oldpython

rem ---------- 2. First-time setup, or repair a broken setup ----------
if exist ".venv\Scripts\python.exe" ".venv\Scripts\python.exe" -c "import sys" >nul 2>&1 || rmdir /s /q ".venv" >nul 2>&1
if not exist ".venv\Scripts\python.exe" (
  echo   First-time setup. This takes a minute or two, and only happens once...
  echo.
  %PY% -m venv .venv || goto :error
)

rem ---------- 3. Install or update what Shelfie needs, only when it changed ----------
fc /b requirements.txt ".venv\installed-requirements.txt" >nul 2>&1
if errorlevel 1 (
  echo   Downloading the parts Shelfie needs. You must be connected to the internet...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :error
  copy /y requirements.txt ".venv\installed-requirements.txt" >nul
  echo   Done.
  echo.
)

rem ---------- 4. Offer a Desktop button, once ----------
if not exist ".venv\shortcut-offered.txt" call :offershortcut

rem ---------- 5. Start ----------
echo   Starting Shelfie. Your web browser will open in a moment.
echo   KEEP THIS WINDOW OPEN while you use Shelfie. To finish, click "Close Shelfie" in the app
echo   or simply close this window.
".venv\Scripts\python.exe" app.py
if errorlevel 4 if not errorlevel 5 goto :eof
if errorlevel 3 if not errorlevel 4 goto :alreadyopen
echo.
echo   Shelfie has stopped. You can close this window.
pause >nul
goto :eof

:offershortcut
echo asked> ".venv\shortcut-offered.txt"
echo   Tip: Shelfie can put a "Shelfie" button on your Desktop and in the Start menu,
echo   so next time you can start it with one click.
choice /c YN /n /m "  Add the Shelfie button? Press Y for yes or N for no: "
if errorlevel 2 (
  echo   No problem. You can add it later from Shelfie's Settings page.
  echo.
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-shortcut.ps1"
echo.
exit /b 0

:alreadyopen
echo.
echo   Shelfie was already open, so it has been shown in your browser.
echo   This window will close by itself.
ping -n 6 127.0.0.1 >nul
goto :eof

:nopython
echo   Shelfie needs a free program called Python, and it is not installed yet.
echo.
where winget >nul 2>&1 || goto :manualpython
choice /c YN /n /m "  Install Python automatically now? Press Y for yes or N for no: "
if errorlevel 2 goto :manualpython
echo.
echo   Installing Python. Windows may ask for permission, so click Yes if it does...
winget install --id Python.Python.3.13 -e --scope user --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :manualpython
echo.
echo   Python is installed. Continuing...
echo.
set "JUST_INSTALLED=1"
goto :findpython

:restartneeded
echo   Python is installed, but Windows needs a fresh window to find it.
echo   Please CLOSE this window and double-click Shelfie-Windows.bat again.
pause
goto :eof

:manualpython
echo.
echo   Let's install Python by hand. It only takes a minute:
echo   1. Your browser will now open the Python download page.
echo   2. Click the yellow "Download Python" button and run the file you downloaded.
echo   3. IMPORTANT: on the first screen of the installer, tick the box
echo      "Add python.exe to PATH", then click "Install Now".
echo   4. When it has finished, double-click Shelfie-Windows.bat again.
echo.
start "" "https://www.python.org/downloads/"
pause
goto :eof

:oldpython
echo   Your Python is too old. Shelfie needs Python 3.10 or newer.
echo   Install the latest version from https://www.python.org/downloads/
echo   and tick "Add python.exe to PATH" in the installer. Then run Shelfie-Windows.bat again.
start "" "https://www.python.org/downloads/"
pause
goto :eof

:error
echo.
echo   Something went wrong during setup.
echo   - Check that you are connected to the internet, then double-click Shelfie-Windows.bat again.
echo   - If it keeps failing, delete the ".venv" folder next to Shelfie-Windows.bat and try once more.
echo   - See "Troubleshooting" in USER_GUIDE.md for more help.
pause
goto :eof
