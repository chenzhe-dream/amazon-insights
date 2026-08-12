# Copy Chrome Default profile to a dedicated debug profile, then launch with CDP.
# This reuses your Amazon login cookies on the same Windows user account.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = if ($env:ALEXA_CDP_PORT) { $env:ALEXA_CDP_PORT } else { "9222" }
$sourceUserData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
$sourceDefault = Join-Path $sourceUserData "Default"
$targetRoot = Join-Path $root "data\chrome-alexa-cdp"
$targetDefault = Join-Path $targetRoot "Default"

$chrome = Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  Write-Host "[error] chrome.exe not found" -ForegroundColor Red
  exit 1
}

if (Get-Process chrome -ErrorAction SilentlyContinue) {
  Write-Host "[warn] Close all Chrome windows first, then rerun this script." -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $sourceDefault)) {
  Write-Host "[error] Chrome Default profile not found: $sourceDefault" -ForegroundColor Red
  exit 1
}

Write-Host "[sync] Copying Chrome Default profile (first run may take ~1 min)..."
New-Item -ItemType Directory -Force -Path $targetDefault | Out-Null
robocopy $sourceDefault $targetDefault /MIR /XD "Cache" "Code Cache" "GPUCache" "Service Worker" /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) {
  Write-Host "[error] robocopy failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit 1
}

Write-Host "[ok] Profile ready: $targetRoot"
Write-Host "[ok] Starting Chrome remote-debugging-port=$port"
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=$port",
  "--remote-debugging-address=127.0.0.1",
  "--user-data-dir=`"$targetRoot`"",
  "--profile-directory=Default",
  "--no-first-run",
  "https://www.amazon.com/"
)

Start-Sleep -Seconds 6
try {
  $version = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 8
  Write-Host "[ok] CDP ready: $($version.Content)"
} catch {
  Write-Host "[warn] CDP not reachable yet. Wait a few seconds and check http://127.0.0.1:$port/json/version" -ForegroundColor Yellow
}

Write-Host ""
Write-Host ('  $env:ALEXA_CDP_URL="http://127.0.0.1:' + $port + '"')
Write-Host "  npm run alexa:sync -- B09V5RW2VK"
