# repatch-claude-code.ps1 — Claude Desktop 更新捆绑的 Claude Code 后重新打 ClawGod 补丁
# 全自动: 自动定位 node / 补丁引擎 / Claude 数据目录 / 最新版本, 均不写死
# 用法:
#   powershell -ExecutionPolicy Bypass -File repatch-claude-code.ps1                # 自动: 最新引擎(可选在线更新)+最新版本
#   powershell -ExecutionPolicy Bypass -File repatch-claude-code.ps1 -UpdateEngine  # 先从 GitHub 拉 ClawGod 最新补丁引擎再打
#   powershell -ExecutionPolicy Bypass -File repatch-claude-code.ps1 -Version 2.1.308   # 指定版本
#   powershell -ExecutionPolicy Bypass -File repatch-claude-code.ps1 -Rollback      # 还原该版本原始 exe
param(
    [switch]$Rollback,
    [switch]$UpdateEngine,
    [switch]$SkipRestart,
    [string]$Version = ""
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
# 环境变量可能缺失/被沙箱剥离: 用已知文件夹 API 兼底
$LocalAppData = $env:LOCALAPPDATA
if (-not $LocalAppData) { $LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData) }
if (-not $LocalAppData) { throw "无法定位 LocalAppData (环境变量与已知文件夹均失败)" }
$TmpDir = if ($env:TEMP -and (Test-Path $env:TEMP)) { $env:TEMP } else { $Root }

# ── 1. 自动定位 node.exe ────────────────────────────────────────────
function Find-Node {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        'C:\Program Files\nodejs\node.exe',
        'D:\Program Files\nodejs\node.exe',
        'D:\Program Files\AutoClaw\resources\vendor\node\node.exe'
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    $hit = Get-ChildItem 'D:\Program Files\AutoClaw\resources\vendor' -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
    throw "找不到 node.exe, 请装 Node.js 或把它加入 PATH"
}
$Node = Find-Node
Write-Host "[1/6] node: $Node"

# ── 2. 补丁引擎 (clawgod-engine 优先, 回退 clawgod-scan, -UpdateEngine 在线刷新) ──
$EngineDir = $null
foreach ($d in @('clawgod-engine', 'clawgod-scan')) {
    $p = Join-Path $Root $d
    if ((Test-Path (Join-Path $p 'patch.mjs')) -and (Test-Path (Join-Path $p 'extract-natives.mjs'))) { $EngineDir = $p; break }
}
if (-not $EngineDir -or $UpdateEngine) {
    Write-Host "[2/6] 从 GitHub 拉取 ClawGod 最新补丁引擎..."
    $zip = Join-Path $TmpDir ("clawgod-" + [Guid]::NewGuid().ToString('N') + ".zip")
    $ok = $false
    foreach ($i in 1..3) {
        try { Invoke-WebRequest -Uri 'https://codeload.github.com/0Chencc/clawgod/zip/refs/heads/main' -OutFile $zip -UseBasicParsing -TimeoutSec 90; $ok = $true; break }
        catch { Write-Host "  下载重试 $i..."; Start-Sleep 3 }
    }
    if ($ok) {
        $ex = Join-Path $TmpDir ("clawgod-x-" + [Guid]::NewGuid().ToString('N'))
        Expand-Archive $zip $ex -Force
        $src = Get-ChildItem $ex -Directory | Select-Object -First 1
        $newEngine = Join-Path $Root 'clawgod-engine'
        if (Test-Path $newEngine) { Remove-Item $newEngine -Recurse -Force }
        New-Item $newEngine -ItemType Directory | Out-Null
        foreach ($f in 'extract-natives.mjs', 'patch.mjs', 'ast-patches.mjs', 'acorn.mjs') {
            $src1 = Join-Path $src.FullName "src\shared\$f"
            $src2 = Join-Path $src.FullName "src\$f"
            if (Test-Path $src1) { Copy-Item $src1 $newEngine -Force }
            elseif (Test-Path $src2) { Copy-Item $src2 $newEngine -Force }
            else { throw "上游引擎缺少文件: $f (仓库结构可能已变化)" }
        }
        $EngineDir = $newEngine
        Write-Host "  引擎已更新 → $EngineDir"
        Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
    elseif ($EngineDir) { Write-Host "  [警告] 在线更新失败, 沿用本地引擎: $EngineDir" -ForegroundColor Yellow }
    else { throw "无本地引擎且在线更新失败" }
}
else { Write-Host "[2/6] 补丁引擎: $EngineDir (加 -UpdateEngine 可同步上游)" }

# ── 3. 自动定位 Claude 数据目录 (Claude-3p / Claude / 其他 Claude*) ──
function Find-CcRoot {
    $roots = @()
    foreach ($name in @('Claude-3p', 'Claude')) {
        $p = Join-Path $LocalAppData $name
        if (Test-Path (Join-Path $p 'claude-code')) { $roots += (Join-Path $p 'claude-code') }
    }
    if (-not $roots) {
        $roots = Get-ChildItem $LocalAppData -Directory -Filter 'Claude*' -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'claude-code') } |
            ForEach-Object { Join-Path $_.FullName 'claude-code' }
    }
    if (-not $roots) { throw "在 $LocalAppData 下没找到任何 Claude*\claude-code 目录" }
    # 选含最多版本目录的那个
    $roots | Sort-Object { (Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue).Count } -Descending | Select-Object -First 1
}
$CcRoot = Find-CcRoot

# ── 4. 自动选最新版本目录 + hash 目录 ──────────────────────────────
function Find-Target {
    param([string]$Ver)
    $dirs = Get-ChildItem $CcRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0.0' } } -Descending
    foreach ($d in $dirs) {
        if ($Ver -and $d.Name -ne $Ver) { continue }
        $hash = Get-ChildItem $d.FullName -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'claude.exe') } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($hash) {
            return @{ Version = $d.Name; Dir = $hash.FullName; Exe = (Join-Path $hash.FullName 'claude.exe') }
        }
    }
    throw "未找到可用的 claude.exe (root=$CcRoot$(if ($Ver) { ", ver=$Ver" }))"
}
$t = Find-Target $Version
Write-Host "[3/6] 目标: v$($t.Version)  $($t.Exe)"

function Stop-ClaudeFamily {
    param([string]$CodeExe)
    Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'C:\Program Files\WindowsApps\Claude_*' -or $_.Path -eq $CodeExe } | Stop-Process -Force
    Start-Sleep -Seconds 2
}

function Restart-Desktop {
    $app = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID -like 'Claude_*!*' } | Select-Object -First 1
    if ($app) { Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$($app.AppID)"; Write-Host "  Claude Desktop 已重启" }
    else { Write-Host "  请手动启动 Claude Desktop" -ForegroundColor Yellow }
}

# ── 5. 回滚分支 ─────────────────────────────────────────────────────
if ($Rollback) {
    $orig = Join-Path $Root "claude.orig-$($t.Version).exe"
    if (-not (Test-Path $orig)) { throw "找不到原始备份: $orig" }
    Stop-ClaudeFamily $t.Exe
    [System.IO.File]::WriteAllBytes($t.Exe, [System.IO.File]::ReadAllBytes($orig))
    Write-Host "[✅] 已还原 v$($t.Version) 原始 claude.exe" -ForegroundColor Green
    if (-not $SkipRestart) { Restart-Desktop }
    exit 0
}

# ── 6. 提取 → 打补丁 → 重打包 → 烟测 → 换入 ─────────────────────────
$backup = Join-Path $Root "claude.orig-$($t.Version).exe"
if (-not (Test-Path $backup)) {
    # 部署前先确认当前 exe 是原始版(避免把补丁版当原始版备份)
    if ((Get-Item $t.Exe).Length -gt 300MB) { throw "当前 exe 疑似已是补丁版且无原始备份, 先获取官方原版" }
    [System.IO.File]::WriteAllBytes($backup, [System.IO.File]::ReadAllBytes($t.Exe))
    Write-Host "[4/6] 已备份原始版 → $backup"
}
else { Write-Host "[4/6] 原始备份已存在: $backup" }

$work = Join-Path $Root "clawgod-work-$($t.Version)"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item $work -ItemType Directory | Out-Null
Copy-Item (Join-Path $EngineDir 'extract-natives.mjs'), (Join-Path $EngineDir 'patch.mjs'), (Join-Path $EngineDir 'ast-patches.mjs'), (Join-Path $EngineDir 'acorn.mjs') $work

& $Node (Join-Path $work 'extract-natives.mjs') $backup $work | Out-Null
if ($LASTEXITCODE -ne 0) { throw "提取失败" }
Move-Item (Join-Path $work 'cli.original.js') (Join-Path $work 'cli.original.cjs') -Force

& $Node (Join-Path $work 'patch.mjs') 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw "补丁失败 (上游结构变化, 已中止, 未部署)" }

$repackJs = Join-Path $Root 'repack.js'
if (-not (Test-Path $repackJs)) { throw "缺少 repack.js: $repackJs" }
$out = Join-Path $Root "claude.patched-$($t.Version).exe"
& $Node $repackJs $backup $work $out 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw "重打包失败" }

$verOut = Join-Path $TmpDir 'ccv.txt'; $verErr = Join-Path $TmpDir 'cce.txt'
$p = Start-Process -FilePath $out -ArgumentList '--version' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $verOut -RedirectStandardError $verErr
$verTxt = (Get-Content $verOut -Raw -ErrorAction SilentlyContinue) -join ''
if ($p.ExitCode -ne 0 -or -not $verTxt.Contains($t.Version)) { throw "烟测失败: $(Get-Content $verErr -Raw -ErrorAction SilentlyContinue)" }

Stop-ClaudeFamily $t.Exe
Copy-Item $out "$($t.Dir)\claude.exe.new" -Force
Move-Item "$($t.Dir)\claude.exe.new" $t.Exe -Force
Write-Host "[5/6] 已部署补丁版 v$($t.Version) ($([math]::Round((Get-Item $out).Length / 1MB, 1)) MB)" -ForegroundColor Green

if (-not $SkipRestart) { Restart-Desktop } else { Write-Host "[6/6] 已跳过重启" }
