# dsh-auto-vision 一键安装脚本
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1
# 效果: 1) 复制插件到 %DSH_HOME%\profiles\web\node_modules\dsh-auto-vision\
#       2) 备份并写入 %DSH_HOME%\profiles\web\cordis.patch.yml 启用插件
#       3) 提示重启 DSH Desktop
param(
    [string]$DshHome = $env:DSH_HOME,
    [string]$RepoRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
if (-not $DshHome) { throw "DSH_HOME 未设置" }
if (-not (Test-Path "$RepoRoot\lib\index.js")) { throw "未找到 $RepoRoot\lib\index.js" }

$pluginDir = Join-Path $DshHome "profiles\web\node_modules\dsh-auto-vision"
$patchPath = Join-Path $DshHome "profiles\web\cordis.patch.yml"

# 1) 部署插件包
New-Item -ItemType Directory -Path "$pluginDir\lib" -Force | Out-Null
Copy-Item "$RepoRoot\lib\index.js" "$pluginDir\lib\index.js" -Force
Copy-Item "$RepoRoot\package.json" "$pluginDir\package.json" -Force
Write-Host "[1/3] 插件已部署到 $pluginDir"

# 2) 写入 patch（幂等：已存在 auto-vision 则跳过）
$patchText = if (Test-Path $patchPath) { Get-Content $patchPath -Raw -Encoding UTF8 } else { "" }
if ($patchText -match "id: auto-vision") {
    Write-Host "[2/3] cordis.patch.yml 已包含 auto-vision，跳过"
} else {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item $patchPath "$patchPath.bak-$stamp" -ErrorAction SilentlyContinue
    $block = @"

# dsh-auto-vision: 自动视觉路由插件（auto-vision 项目）
- insert:
    - id: auto-vision
      name: dsh-auto-vision
      config:
        enabled: true
"@
    # 若 patch 原为 `[]` 空数组，需替换为我们的条目（避免双文档）
    if ($patchText.Trim() -eq "[]") { $patchText = "" }
    Add-Content -Path $patchPath -Value $block -Encoding UTF8
    Write-Host "[2/3] 已写入 cordis.patch.yml（原文件备份为 cordis.patch.yml.bak-$stamp）"
}

Write-Host "[3/3] 完成。请重启 DSH Desktop 使插件生效。"
Write-Host "验证: node $RepoRoot\test\verify.mjs"
