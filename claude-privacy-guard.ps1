# claude-privacy-guard.ps1 v2  (interactive menu)
# Claude Desktop privacy guard - telemetry block + special claude.ai kill-switch.
# Touches NOTHING inside the Appx install dir -> survives every auto-update.
#
# Usage:
#   interactive menu :  powershell -NoProfile -ExecutionPolicy Bypass -File claude-privacy-guard.ps1
#   direct mode      :  ... -Mode Scan|Status|Clean|InstallWatch|UninstallWatch
#   admin needed for :  Block/UnblockTelemetry/ClaudeAiBlock/ClaudeAiUnblock/InstallWatch/UninstallWatch
#                        (menu auto-elevates with one UAC prompt)

param([string]$Mode = '')

$ErrorActionPreference = 'Continue'
if ($env:ProgramData)  { $PD = $env:ProgramData }  else { $PD = 'C:\ProgramData' }
if ($env:LOCALAPPDATA) { $LA = $env:LOCALAPPDATA } else { $LA = Join-Path $env:USERPROFILE 'AppData\Local' }
if ($env:SystemRoot)   { $SR = $env:SystemRoot }   else { $SR = 'C:\Windows' }
$GuardDir   = Join-Path $PD 'ClaudeGuard'
$LogFile    = Join-Path $GuardDir 'guard.log'
$BaselineF  = Join-Path $GuardDir 'baseline-endpoints.txt'
$ReportF    = Join-Path $GuardDir 'report.txt'
$HostsPath  = Join-Path $SR 'System32\drivers\etc\hosts'
$TaskName   = 'ClaudePrivacyGuard-Rescan'
$SecTele    = 'claude-guard-telemetry'
$SecClaudeAi= 'claude-guard-claudeai'

# functional domains never blocked by the telemetry layer
$Allowlist = @('claude.ai','claude.com','anthropic.com','ant.dev','jsdelivr.net',
               'cloudflare.com','github.com','microsoftonline.com','googleapis.com',
               'accounts.google.com','box.com','microsoft.com','msftauth.net')
# known telemetry sinks (direct-connection candidates)
$BlockKnown = @('sentry.io','ingest.sentry.io','statsig.com','api.statsig.com',
                'events.statsigapi.net','featuregates.org','featureassets.org',
                'amplitude.com','api2.amplitude.com','segment.io','api.segment.io')
# claude.ai kill-switch base set (hosts has NO wildcards -> enumerate; Scan appends subdomains)
$ClaudeAiBase = @('claude.ai','www.claude.ai','assets.claude.ai','downloads.claude.ai',
                  'preview.claude.ai','cdn.claude.ai','claude.com','www.claude.com',
                  'platform.claude.com','code.claude.com')

function Test-Admin {
  $id = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $id.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Write-Guard([string]$msg) {
  if (-not (Test-Path $GuardDir)) { New-Item -ItemType Directory -Force -Path $GuardDir | Out-Null }
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding ASCII
  Write-Output $line
}
function Get-AppInfo {
  $p = Get-AppxPackage -Name 'Claude' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { return $null }
  [pscustomobject]@{ Version = $p.Version; Res = Join-Path $p.InstallLocation 'app\resources';
                     Asar = Join-Path $p.InstallLocation 'app\resources\app.asar' }
}
# multi-section hosts editor: sections = hashtable name -> domain array (empty array removes section)
function Set-HostsSections([hashtable]$sections) {
  $lines = [System.IO.File]::ReadAllLines($HostsPath)
  $out  = New-Object System.Collections.Generic.List[string]
  $names = @($sections.Keys)
  $done  = @{}
  $i = 0
  while ($i -lt $lines.Count) {
    $l = $lines[$i]; $matched = $null
    foreach ($n in $names) { if (-not $done[$n] -and $l -eq ("# BEGIN " + $n)) { $matched = $n; break } }
    if ($matched) {
      $done[$matched] = $true
      while ($i -lt $lines.Count -and $lines[$i] -ne ("# END " + $matched)) { $i++ }
      $i++  # skip END marker
      $doms = @($sections[$matched])
      if ($doms.Count -gt 0) {
        [void]$out.Add("# BEGIN $matched")
        foreach ($d in ($doms | Sort-Object -Unique)) {
          [void]$out.Add("0.0.0.0 $d")   # IPv4 sinkhole (unroutable, safer than 127.0.0.1)
          [void]$out.Add("::1 $d")       # IPv6 sinkhole - without this AAAA lookups bypass the block
        }
        [void]$out.Add("# END $matched")
      }
      continue
    }
    [void]$out.Add($l); $i++
  }
  foreach ($n in $names) {
    if (-not $done[$n] -and @($sections[$n]).Count -gt 0) {
      [void]$out.Add("# BEGIN $n")
      foreach ($d in ($sections[$n] | Sort-Object -Unique)) {
        [void]$out.Add("0.0.0.0 $d")
        [void]$out.Add("::1 $d")
      }
      [void]$out.Add("# END $n")
    }
  }
  $tmp = "$HostsPath.guardtmp"
  [System.IO.File]::WriteAllLines($tmp, $out)
  Move-Item $tmp $HostsPath -Force
  & ipconfig /flushdns | Out-Null
}
function Get-HostsSection([string]$name) {
  if (-not (Test-Path $HostsPath)) { return @() }
  $inSec = $false; $r = @()
  foreach ($l in [System.IO.File]::ReadAllLines($HostsPath)) {
    if ($l -eq ("# BEGIN " + $name)) { $inSec = $true; continue }
    if ($l -eq ("# END " + $name))   { $inSec = $false; continue }
    if ($inSec -and $l -match '^(0\.0\.0\.0|::1)\s+(\S+)') { $r += $Matches[2] }
  }
  return $r
}
function Get-ScanDomains {
  # zero-dependency extraction: .NET regex over Latin1-decoded bytes (no rg.exe needed)
  $app = Get-AppInfo; if (-not $app) { return @() }
  $rx = [regex]'https://[a-zA-Z0-9._-]+'
  $doms = @()
  $files = New-Object System.Collections.Generic.List[string]
  if (Test-Path $app.Asar) { [void]$files.Add($app.Asar) }
  $ion = Join-Path $app.Res 'ion-dist'
  if (Test-Path $ion) {
    Get-ChildItem $ion -Recurse -File -Include *.js, *.html, *.json -ErrorAction SilentlyContinue |
      ForEach-Object { [void]$files.Add($_.FullName) }
  }
  foreach ($f in $files) {
    try {
      $t = [IO.File]::ReadAllText($f, [Text.Encoding]::GetEncoding('ISO-8859-1'))
      foreach ($m in $rx.Matches($t)) { $doms += ($m.Value -replace '^https://', '') }
    } catch { continue }
  }
  return @($doms | Where-Object { $_ -match '^[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}$' } | Sort-Object -Unique)
}

# ================= actions =================
function Invoke-Scan {
  $app = Get-AppInfo; if (-not $app) { Write-Output 'Claude Appx not found'; return }
  Write-Guard ("scan start version=" + $app.Version)
  $all = Get-ScanDomains
  Set-Content -Path $BaselineF -Value ("# version=" + $app.Version) -Encoding ASCII
  Add-Content -Path $BaselineF -Value $all -Encoding ASCII
  $suspects = $all | Where-Object {
    $h = $_
    -not ($Allowlist | Where-Object { $h -eq $_ -or $h -like ("*." + $_) }) -and
    ($h -match 'sentry|statsig|telemetry|ingest|metric|analytics|amplitude|segment|crash')
  }
  $dns = Get-DnsClientCache -ErrorAction SilentlyContinue |
         Where-Object { $_.Entry -match 'sentry|statsig|ingest|telemetry|amplitude|segment' } |
         Select-Object -ExpandProperty Entry -Unique
  $report = @()
  $report += "Claude guard scan report  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  $report += "app version : $($app.Version)"
  $report += "total hosts : $($all.Count)"
  $report += "code-flagged telemetry candidates:"
  $report += ($suspects | ForEach-Object { "  [code] $_" })
  $report += "actually-resolved (DNS cache) telemetry domains:"
  $report += ($dns | ForEach-Object { "  [dns ] $_" })
  $report += "NOTE: relayed telemetry may ride functional domains (claude.ai) -"
  $report += "      use option 5 (claude.ai kill-switch) or Clash REJECT rules for that case."
  Set-Content -Path $ReportF -Value $report -Encoding ASCII
  Write-Guard "scan done"
  $report | Write-Output
}
function Invoke-TelemetryBlock {
  $extra = @()
  if (Test-Path $ReportF) {
    $extra = Select-String -Path $ReportF -Pattern '^\s+\[(code|dns)\]\s+(\S+)' -AllMatches |
             ForEach-Object { $_.Matches[0].Groups[2].Value } |
             Where-Object { $_ -and ($_ -notmatch 'example\.com|invalid|localhost|dummy|docs\.sentry\.io') }
  }
  $final = @($BlockKnown) + @($extra)
  Set-HostsSections @{ $SecTele = $final }
  Write-Guard ("telemetry hosts block: $($final.Count) domains")
  $final | Sort-Object -Unique | ForEach-Object { Write-Output "  blocked: $_" }
}
function Invoke-ClaudeAiBlock {
  $app = Get-AppInfo
  $doms = @($ClaudeAiBase)
  if ($app) {   # enumerate live subdomains from the actual bundle
    $doms += (Get-ScanDomains | Where-Object { $_ -match '(^|\.)claude\.(ai|com)$' })
  }
  Write-Output ("  will block " + @($doms | Sort-Object -Unique).Count + " hosts (claude.ai / claude.com family, enumerated):")
  ($doms | Sort-Object -Unique) | ForEach-Object { Write-Output "    $_" }
  Write-Output "  WARNING: full network kill for Claude Desktop - chat/login/updates all dead."
  Write-Output "  api.anthropic.com is NOT included (Claude Code CLI / API keys keep working)."
  $yn = Read-Host '  confirm? (y/N)'
  if ($yn -notmatch '^[yY]') { Write-Output '  cancelled.'; return }
  Set-HostsSections @{ $SecClaudeAi = @($doms | Sort-Object -Unique) }
  Write-Guard "claude.ai kill-switch ON"
}
function Invoke-Clean {
  $lc = Join-Path $LA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude'
  foreach ($d in (Join-Path $lc 'sentry'), (Join-Path $lc 'Crashpad\reports'), (Join-Path $lc 'Crashpad\pending')) {
    if (Test-Path $d) {
      Get-ChildItem $d -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      Write-Guard "purged $d"
    }
  }
  Write-Output 'queued telemetry artifacts cleared (best with Claude closed).'
}
function Invoke-InstallWatch {
  $self = $PSCommandPath; if (-not $self) { $self = $MyInvocation.MyCommand.Path }
  $act  = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -Mode Scan; powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -Mode BlockTelemetry; powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -Mode Clean"
  $prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
  $t1 = New-ScheduledTaskTrigger -AtLogOn
  $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName $TaskName -Action $act -Principal $prin -Trigger $t1, $t2 `
    -Description 'Claude privacy guard: rescan + reapply hosts blocks after updates' -Force | Out-Null
  Write-Guard 'watch installed (logon + 6h: scan -> block -> clean)'
}
function Invoke-UninstallWatch {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Set-HostsSections @{ $SecTele = @(); $SecClaudeAi = @() }
  Write-Guard 'watch removed, both hosts sections cleared'
}
function Show-Status {
  $app = Get-AppInfo
  $tele = Get-HostsSection $SecTele
  $cai  = Get-HostsSection $SecClaudeAi
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $lc = Join-Path $LA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\sentry'
  $sq = 0; if (Test-Path $lc) { $sq = (Get-ChildItem $lc -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }
  Write-Output '---------------- status ----------------'
  if ($app) { Write-Output ("app            : Claude v" + $app.Version) } else { Write-Output 'app            : NOT INSTALLED' }
  Write-Output ("telemetry block: " + $(if ($tele.Count) { "ON  ($($tele.Count) domains)" } else { 'off' }))
  Write-Output ("claude.ai kill : " + $(if ($cai.Count)  { "ON  ($($cai.Count) hosts)" }  else { 'off' }))
  Write-Output ("auto watch     : " + $(if ($task) { $task.State } else { 'not installed' }))
  Write-Output ("sentry queue   : $([math]::Round($sq/1KB,1)) KB on disk")
  Write-Output ("admin session  : $(Test-Admin)")
  Write-Output '----------------------------------------'
}
function Invoke-LiveWatch {
  Write-Output 'live connections of Claude/Cowork processes - Ctrl+C to stop, refresh 3s'
  while ($true) {
    Clear-Host
    Write-Output ("== live remote endpoints @ " + (Get-Date -Format 'HH:mm:ss') + " ==")
    $pids = (Get-Process | Where-Object { $_.ProcessName -match '(?i)claude|cowork' }).Id
    if ($pids) {
      Get-NetTCPConnection -OwningProcess $pids -State Established -ErrorAction SilentlyContinue |
        ForEach-Object { $pn = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName;
                         '{0,-12} {1}:{2}' -f $pn, $_.RemoteAddress, $_.RemotePort } |
        Group-Object | Sort-Object Count -Descending |
        ForEach-Object { '{0,4}x  {1}' -f $_.Count, $_.Name }
    } else { Write-Output '(no claude/cowork process running)' }
    Start-Sleep -Seconds 3
  }
}

# ============ direct modes (for scheduled task / CLI) ============
switch ($Mode) {
  'Scan'            { Invoke-Scan; break }
  'Status'          { Show-Status; break }
  'Clean'           { Invoke-Clean; break }
  'BlockTelemetry'  { Invoke-TelemetryBlock; break }
  'InstallWatch'    { Invoke-InstallWatch; break }
  'UninstallWatch'  { Invoke-UninstallWatch; break }
  'Menu'            { }
  default {
    if ($Mode -ne '') { Write-Output "unknown mode: $Mode"; break }
  }
}
if ($Mode -ne '') { exit 0 }

# ================= interactive menu =================
while ($true) {
  Write-Output ''
  Write-Output '============= Claude Desktop 隐私守卫 ============='
  Show-Status
  Write-Output ' [1] 状态总览                [6] 解除 claude.ai 封禁'
  Write-Output ' [2] 扫描当前版本端点        [7] 清空本地遥测队列'
  Write-Output ' [3] 开启遥测域名屏蔽        [8] 安装自动守卫 (登录+6h)'
  Write-Output ' [4] 解除遥测域名屏蔽        [9] 移除自动守卫(清全部hosts段)'
  Write-Output ' [5] 特殊禁用: 封禁claude.ai [10] 实时观察网络连接'
  Write-Output ' [0] 退出'
  $choice = Read-Host '选择'
  $needAdmin = @{ '3' = $true; '4' = $true; '5' = $true; '6' = $true; '8' = $true; '9' = $true }
  if ($needAdmin.ContainsKey($choice) -and -not (Test-Admin)) {
    Write-Output '需要管理员权限，正在弹 UAC 提权重启菜单...'
    Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    break
  }
  switch ($choice) {
    '1'  { Show-Status }
    '2'  { Invoke-Scan }
    '3'  { Invoke-TelemetryBlock }
    '4'  { Set-HostsSections @{ $SecTele = @() }; Write-Guard 'telemetry block removed'; Write-Output 'telemetry block removed.' }
    '5'  { Invoke-ClaudeAiBlock }
    '6'  { Set-HostsSections @{ $SecClaudeAi = @() }; Write-Guard 'claude.ai kill-switch OFF'; Write-Output 'claude.ai unblocked.' }
    '7'  { Invoke-Clean }
    '8'  { Invoke-InstallWatch }
    '9'  { Invoke-UninstallWatch }
    '10' { Invoke-LiveWatch }
    '0'  { break }
    default { Write-Output '无效选项' }
  }
  if ($choice -eq '0') { break }
}
