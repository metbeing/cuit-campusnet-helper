# CUIT 校园网助手 一键安装脚本
# 用法: 右键"使用 PowerShell 运行", 或在项目目录执行  powershell -ExecutionPolicy Bypass -File install.ps1
# 做四件事: 定位 Node.js -> 生成 node.path -> 安装依赖(chromium) -> 注册开机计划任务
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
Write-Host "== CUIT 校园网助手 安装 ==" -ForegroundColor Cyan

# 1. 定位 Node.js
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host '未检测到 Node.js, 请先安装: https://nodejs.org (LTS 版本即可)' -ForegroundColor Red
  exit 1
}
Write-Host "Node.js: $node"
Set-Content -Path "$dir\node.path" -Value $node -Encoding ASCII

# 2. 生成配置文件(不覆盖已有配置)
if (-not (Test-Path "$dir\config.json")) {
  Copy-Item "$dir\config.example.json" "$dir\config.json"
  Write-Host '已生成 config.json -- 请先填入账号/密码/运营商, 再重启电脑!' -ForegroundColor Yellow
} else {
  Write-Host 'config.json 已存在, 跳过'
}

# 3. 安装依赖 + Playwright 浏览器
Write-Host '安装 npm 依赖(首次约 1 分钟)...'
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Write-Host 'npm install 失败, 请检查网络' -ForegroundColor Red; exit 1 }
Write-Host '下载 Playwright chromium(首次约 115MB)...'
npx playwright install chromium

# 4. 注册开机计划任务(当前用户, 登录后 4 秒运行, 无需管理员)
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$dir\run-hidden.vbs`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT4S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'CampusAutoLogin' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'CampusAutoLogin'
Write-Host ("计划任务 CampusAutoLogin 已注册: " + $t.State) -ForegroundColor Green

Write-Host ''
Write-Host '安装完成! 接下来:' -ForegroundColor Green
if (-not (Test-Path "$dir\config.json" -PathType Leaf) -or (Select-String -Path "$dir\config.json" -Pattern '在这里填' -Quiet)) {
  Write-Host '  1. 编辑 config.json 填入账号/密码/运营商' -ForegroundColor Yellow
  Write-Host '  2. 重启电脑实测, 或手动跑一次: node login.mjs' -ForegroundColor Yellow
} else {
  Write-Host '  配置已填好, 重启电脑即可全自动联网' -ForegroundColor Yellow
}
