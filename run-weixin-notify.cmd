@echo off
chcp 65001 >nul
cd /d "%~dp0"
if defined NODE_CMD (
  set "NODE=%NODE_CMD%"
) else (
  set "NODE=node.exe"
)
call "%NODE%" .\weixin-codex-bridge.mjs notify %*
