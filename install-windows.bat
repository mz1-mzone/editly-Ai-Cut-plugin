@echo off
REM ============================================
REM Editly AI Cut — Windows Installer
REM One-command install for Adobe Premiere Pro
REM ============================================

echo.
echo ========================================
echo   Editly AI Cut - Installer
echo   AI-Powered Video Editor
echo ========================================
echo.

REM Check for git
where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] git is not installed.
    echo    Download it from: https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

SET PLUGIN_NAME=EditlyPlugin
SET CEP_DIR=%APPDATA%\Adobe\CEP\extensions
SET INSTALL_DIR=%CEP_DIR%\%PLUGIN_NAME%
SET REPO_URL=https://github.com/mz1-mzone/editly-Ai-Cut-plugin.git

REM Create CEP extensions directory
if not exist "%CEP_DIR%" mkdir "%CEP_DIR%"

REM Install or update
if exist "%INSTALL_DIR%\.git" (
    echo Updating existing installation...
    cd /d "%INSTALL_DIR%"
    git pull origin main
    echo.
    echo [OK] Updated successfully!
) else (
    if exist "%INSTALL_DIR%" (
        echo Existing install found. Removing...
        rmdir /s /q "%INSTALL_DIR%"
    )
    echo Downloading plugin...
    git clone "%REPO_URL%" "%INSTALL_DIR%"
    echo.
    echo [OK] Installed successfully!
)

REM Enable unsigned CEP extensions
echo.
echo Enabling unsigned extensions...
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>nul
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>nul

echo.
echo ========================================
echo [OK] Installation complete!
echo.
echo Next steps:
echo   1. Restart Adobe Premiere Pro
echo   2. Go to: Window ^> Extensions ^> Editly AI Cut
echo   3. Click Settings and enter your API keys:
echo      - ElevenLabs API Key (for transcription)
echo      - Anthropic API Key (for AI editing)
echo.
echo   The plugin auto-updates from GitHub!
echo ========================================
echo.
pause
