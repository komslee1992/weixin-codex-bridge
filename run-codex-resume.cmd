@echo off
cd /d "%~dp0"
if not defined CODEX_CMD set "CODEX_CMD=codex.exe"
if exist "%CODEX_CMD%" goto run
where "%CODEX_CMD%" >nul 2>nul
if errorlevel 1 (
  echo codex executable not found. Install Codex CLI or set CODEX_CMD to the full codex.exe path. 1>&2
  exit /b 1
)
:run
"%CODEX_CMD%" exec resume %*
