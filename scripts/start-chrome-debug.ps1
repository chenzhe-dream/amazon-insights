# Launch Chrome with remote debugging to reuse existing Amazon login.
# Usage:
#   1. Close all Chrome windows first
#   2. powershell -ExecutionPolicy Bypass -File .\scripts\start-chrome-debug.ps1
#   3. Confirm amazon.com is signed in
#   4. $env:ALEXA_CDP_URL="http://127.0.0.1:9222"; npm run alexa:sync -- B09V5RW2VK

$ErrorActionPreference = "Stop"
$port = if ($env:ALEXA_CDP_PORT) { $env:ALEXA_CDP_PORT } else { "9222" }
$userData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"

$candidates = @(
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
)

$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  Write-Host "[error] chrome.exe not found" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $userData)) {
  Write-Host "[error] Chrome user data not found: $userData" -ForegroundColor Red
  exit 1
}

$running = Get-Process chrome -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "[warn] Chrome is still running. Close all Chrome windows first." -ForegroundColor Yellow
  exit 1
}

Write-Host "[ok] Starting Chrome remote-debugging-port=$port"
Write-Host "[ok] user-data-dir=$userData"
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=$port",
  "--user-data-dir=`"$userData`"",
  "--profile-directory=Default",
  "https://www.amazon.com/"
)

Write-Host ""
Write-Host "Next:"
Write-Host ('  $env:ALEXA_CDP_URL="http://127.0.0.1:' + $port + '"')
Write-Host "  npm run alexa:sync -- B09V5RW2VK"
