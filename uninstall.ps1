# dsh-auto-vision 一键卸载脚本
# 用法: powershell -ExecutionPolicy Bypass -File uninstall.ps1
param(
    [string]$DshHome = $env:DSH_HOME
)

$ErrorActionPreference = "Stop"
if (-not $DshHome) { throw "DSH_HOME 未设置" }

$pluginDir = Join-Path $DshHome "profiles\web\node_modules\dsh-auto-vision"
$patchPath = Join-Path $DshHome "profiles\web\cordis.patch.yml"

# 1) 从 patch 移除 auto-vision 段
if (Test-Path $patchPath) {
    $text = Get-Content $patchPath -Raw -Encoding UTF8
    $new = $text -replace "(?ms)^# dsh-auto-vision: 自动视觉路由插件.*?(?=^# |\z)", ""
    $new = $new -replace "(?ms)^- insert:\r?\n\s+- id: auto-vision\r?\n.*?(?=^- |\z)", ""
    if ($new.Trim() -eq "") { $new = "[]`n" }
    Set-Content -Path $patchPath -Value $new -Encoding UTF8
    Write-Host "[1/2] 已从 cordis.patch.yml 移除 auto-vision"
}

# 2) 删除插件目录
if (Test-Path $pluginDir) {
    Remove-Item $pluginDir -Recurse -Force
    Write-Host "[2/2] 已删除 $pluginDir"
}

Write-Host "完成。请重启 DSH Desktop。备份文件 cordis.patch.yml.bak-* 可手动清理。"
