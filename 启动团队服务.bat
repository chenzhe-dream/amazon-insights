@echo off
chcp 65001 >nul
title Amazon 竞品数据分析 - 团队局域网服务
cd /d "%~dp0"
echo.
echo ========================================
echo   Amazon 竞品数据分析 - 团队局域网服务
echo ========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-team-server.ps1" %*
if errorlevel 1 (
  echo.
  echo 启动失败，请检查 Node.js 是否已安装。
  pause
)
