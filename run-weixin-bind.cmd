@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
if defined NPM_CMD (
  set "NPM=%NPM_CMD%"
) else (
  set "NPM=npm.cmd"
)
call "%NPM%" run weixin:bind > logs\bind.out.log 2> logs\bind.err.log
