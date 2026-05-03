@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
if defined NPM_CMD (
  set "NPM=%NPM_CMD%"
) else (
  set "NPM=npm.cmd"
)
call "%NPM%" run weixin:bridge > logs\bridge.out.log 2> logs\bridge.err.log
