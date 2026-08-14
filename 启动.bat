@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\@deepseek-ai\dsh\lib\bin.js" (
  echo [首次运行] 正在安装依赖（Electron 走国内镜像，需要几分钟）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请查看上方输出。
    pause
    exit /b 1
  )
)

echo 正在启动 DeepSeek Harness Desktop ...
call npm start
pause
