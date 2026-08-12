# Start the competitor analysis site for team access on the company LAN.
param(
  [switch]$SkipBuild,
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$FirewallRuleName = "Amazon Competitor Analysis"

function Get-LanAddresses {
  $fromNet = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*"
    } |
    Select-Object -ExpandProperty IPAddress -Unique)

  if ($fromNet.Count -gt 0) { return $fromNet }

  return @(ipconfig | Select-String -Pattern "IPv4[^:]*:\s*(\d+\.\d+\.\d+\.\d+)" |
    ForEach-Object { $_.Matches[0].Groups[1].Value } |
    Where-Object { $_ -notlike "127.*" -and $_ -notlike "169.254.*" } |
    Select-Object -Unique)
}

function Ensure-FirewallRule {
  param([int]$LocalPort)

  $existing = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "[ok] Firewall rule already exists: $FirewallRuleName"
    return
  }

  try {
    New-NetFirewallRule `
      -DisplayName $FirewallRuleName `
      -Direction Inbound `
      -Protocol TCP `
      -LocalPort $LocalPort `
      -Action Allow `
      -Profile Any `
      -ErrorAction Stop | Out-Null
    Write-Host "[ok] Created firewall inbound rule: $FirewallRuleName (TCP $LocalPort)"
  } catch {
    Write-Host "[warn] Could not create firewall rule automatically (admin rights may be required)."
    Write-Host "       If teammates cannot connect, run as Administrator:"
    Write-Host "       New-NetFirewallRule -DisplayName '$FirewallRuleName' -Direction Inbound -Protocol TCP -LocalPort $LocalPort -Action Allow"
  }
}

function Stop-PortListener {
  param([int]$LocalPort)

  $connections = netstat -ano | Select-String "LISTENING" | Select-String ":$LocalPort\s"
  foreach ($line in $connections) {
    $processId = ($line -split "\s+")[-1]
    if ($processId -match "^\d+$" -and [int]$processId -gt 0) {
      Write-Host "[info] Port $LocalPort is in use (PID $processId). Stopping old process..."
      Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $fallbackNode = "C:\Program Files\nodejs\node.exe"
  if (Test-Path $fallbackNode) {
    $env:Path = "C:\Program Files\nodejs;" + $env:Path
  } else {
    throw "Node.js not found. Install Node >= 22.13.0 first."
  }
}

Write-Host ""
Write-Host "Amazon Competitor Analysis - Team LAN Server"
Write-Host "Project: $ProjectRoot"
Write-Host ""

Ensure-FirewallRule -LocalPort $Port
Stop-PortListener -LocalPort $Port

if (-not $SkipBuild) {
  Write-Host "[build] Building production bundle..."
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ""
} elseif (-not (Test-Path "$ProjectRoot\dist\server\index.js")) {
  Write-Host "[build] dist/ missing, running full build..."
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ""
}

$lanIps = @(Get-LanAddresses)
$accessFile = Join-Path $ProjectRoot "团队访问地址.txt"
$accessLines = @(
  "Amazon 竞品数据分析 - 团队局域网访问地址",
  "更新时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  ""
)
Write-Host "Teammates can open:"
if ($lanIps.Count -gt 0) {
  foreach ($ip in $lanIps) {
    $url = "http://${ip}:$Port/"
    Write-Host "  $url"
    $accessLines += $url
  }
} else {
  Write-Host "  http://<your-lan-ip>:$Port/  (run ipconfig to find IPv4)"
  $accessLines += "http://<your-lan-ip>:$Port/"
}
$accessLines += ""
$accessLines += "Local: http://localhost:$Port/"
$accessLines += "Stop server: close this window or press Ctrl+C in the server terminal."
Set-Content -Path $accessFile -Value $accessLines -Encoding UTF8
Write-Host ""
Write-Host "Saved access URLs to: $accessFile"
Write-Host ""
Write-Host "Local: http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

$env:PORT = "$Port"
npm run start
