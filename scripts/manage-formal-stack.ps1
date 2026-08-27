[CmdletBinding()]
param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$RuntimeRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime')
)

$ErrorActionPreference = 'Stop'

function Read-StrictEnvFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw '正式配置文件不存在'
  }

  $result = @{}
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0])) {
      throw '正式配置格式无效'
    }
    $result[$parts[0].Trim()] = $parts[1]
  }
  return $result
}

function Assert-FormalConfig($Config) {
  $required = @(
    'AGENT_DATABASE_URL',
    'AGENT_VOC_LOCAL_FAKE',
    'WEB_HOST',
    'WEB_PORT',
    'AGENT_SERVICE_HOST',
    'AGENT_SERVICE_PORT',
    'AGENT_SERVICE_INTERNAL_URL',
    'AGENT_SERVICE_TRUSTED_ORIGINS',
    'AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE'
  )
  foreach ($key in $required) {
    if (-not $Config.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($Config[$key])) {
      throw "正式配置缺少 $key"
    }
  }
  if ($Config.AGENT_VOC_LOCAL_FAKE -ne '0') { throw '正式 fake 模式必须关闭' }
  if ($Config.WEB_HOST -ne '0.0.0.0' -or $Config.WEB_PORT -ne '31900') {
    throw 'Web 正式监听配置无效'
  }
  if ($Config.AGENT_SERVICE_HOST -ne '127.0.0.1' -or $Config.AGENT_SERVICE_PORT -ne '31901') {
    throw 'Agent 正式监听配置无效'
  }
  if ($Config.AGENT_SERVICE_INTERNAL_URL -ne 'http://127.0.0.1:31901') {
    throw 'Agent 内部地址无效'
  }
  if ($Config.AGENT_DATABASE_URL -notmatch '^postgres(?:ql)?://') {
    throw 'PostgreSQL 正式配置无效'
  }
  if ($Config.AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE -ne '1') {
    throw 'LAN 登录配置无效'
  }
}

function Resolve-ManagedStackAction($State) {
  if ([int]$State.active -gt 0) { return @{ action = 'refuse-active' } }
  if ([bool]$State.healthy -and -not [bool]$State.owned) { return @{ action = 'refuse-foreign' } }
  if ([bool]$State.owned -and [bool]$State.healthy) { return @{ action = 'restart' } }
  if ([bool]$State.owned) { return @{ action = 'replace-stale' } }
  return @{ action = 'start' }
}

function Initialize-FormalConfig([string]$TargetRuntimeRoot) {
  $target = Join-Path $TargetRuntimeRoot 'formal-stack.env'
  if (Test-Path -LiteralPath $target -PathType Leaf) { return $target }

  $source = 'C:\Users\EDY\AppData\Local\Temp\amazon-insights-postgres-credentials-20260820-094538.env'
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw '受保护的 PostgreSQL 配置不可用'
  }
  $databaseLines = @(Get-Content -LiteralPath $source | Where-Object { $_ -like 'AGENT_DATABASE_URL=*' })
  if ($databaseLines.Count -ne 1) { throw '受保护的 PostgreSQL 配置不可用' }

  New-Item -ItemType Directory -Path $TargetRuntimeRoot -Force | Out-Null
  $lines = @(
    'NODE_ENV=development',
    'WEB_HOST=0.0.0.0',
    'WEB_PORT=31900',
    'AGENT_SERVICE_HOST=127.0.0.1',
    'AGENT_SERVICE_PORT=31901',
    'AGENT_SERVICE_INTERNAL_URL=http://127.0.0.1:31901',
    'AGENT_SERVICE_TRUSTED_ORIGINS=http://192.168.1.109:31900,http://127.0.0.1:31900',
    'AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=1',
    'AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=0',
    'AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=0',
    'AGENT_VOC_LOCAL_FAKE=0',
    'AGENT_VOC_WORKER_OWNER_ID=private-lan-formal-stack-31900',
    $databaseLines[0]
  )
  [IO.File]::WriteAllLines($target, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
  return $target
}

function Set-FormalEnvironment($Config) {
  foreach ($entry in $Config.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
  }
  $tokenBytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
  $token = -join ($tokenBytes | ForEach-Object { $_.ToString('x2') })
  [Environment]::SetEnvironmentVariable('AGENT_SERVICE_PROXY_TOKEN', $token, 'Process')
}

function Invoke-PostgresPreflight([string]$Root) {
  $source = @'
import pg from "pg";
const client = new pg.Client({
  connectionString: process.env.AGENT_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
try {
  await client.connect();
  const { rows } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM sync_jobs WHERE status IN ('queued', 'running')) +
      (SELECT count(*)::int FROM run_stages WHERE status IN ('queued', 'running')) +
      (SELECT count(*)::int FROM job_attempts WHERE status IN ('queued', 'running')) +
      (SELECT count(*)::int FROM analysis_runs WHERE status IN ('queued', 'running')) AS active
  `);
  process.stdout.write(JSON.stringify({ ok: true, active: Number(rows[0]?.active ?? -1) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "POSTGRES_UNAVAILABLE" }));
  process.exitCode = 2;
} finally {
  await client.end().catch(() => {});
}
'@
  $output = $source | & node --input-type=module - 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 连接或活动任务检查失败' }
  $result = $output | ConvertFrom-Json
  if (-not $result.ok -or [int]$result.active -lt 0) { throw 'PostgreSQL 连接或活动任务检查失败' }
  return $result
}

function Get-ListenerProcessIds([int]$Port) {
  return @(
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
}

function Test-HttpOk([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
    return [int]$response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Read-ManagerState([string]$StatePath) {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-IsDescendant([int]$ProcessId, [int]$AncestorId) {
  $visited = @{}
  $current = $ProcessId
  while ($current -gt 0 -and -not $visited.ContainsKey($current)) {
    if ($current -eq $AncestorId) { return $true }
    $visited[$current] = $true
    $record = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
    if (-not $record) { return $false }
    $current = [int]$record.ParentProcessId
  }
  return $false
}

function Test-ProcessStartTimeMatch([DateTime]$ObservedUtc, $StoredValue) {
  if ($StoredValue -is [DateTime]) {
    $storedUtc = $StoredValue.ToUniversalTime()
  } else {
    $storedUtc = [DateTimeOffset]::Parse(
      [string]$StoredValue,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).UtcDateTime
  }
  return [Math]::Abs(($ObservedUtc.ToUniversalTime() - $storedUtc).TotalSeconds) -le 1
}

function Test-ManagedStackIdentity($State, [string]$Root) {
  if (-not $State) { return $false }
  $expectedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $storedRoot = [IO.Path]::GetFullPath([string]$State.worktree).TrimEnd('\')
  if ($storedRoot -ne $expectedRoot) { return $false }

  $pidValue = [int]$State.supervisorPid
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $observedStart = $process.StartTime.ToUniversalTime()
  if (-not (Test-ProcessStartTimeMatch $observedStart $State.supervisorStartTime)) { return $false }

  $record = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
  $expectedScript = Join-Path $expectedRoot 'scripts\start-agent-stack.mjs'
  if (-not $record -or [string]$record.CommandLine -notlike "*$expectedScript*") { return $false }

  foreach ($port in @(31900, 31901)) {
    $owners = @(Get-ListenerProcessIds $port)
    if ($owners.Count -ne 1 -or -not (Test-IsDescendant ([int]$owners[0]) $pidValue)) { return $false }
  }
  return $true
}

function Stop-OwnedStack($State, [string]$Root, [string]$StatePath) {
  if (-not (Test-ManagedStackIdentity $State $Root)) {
    throw '现有服务不属于本启动器，已拒绝停止'
  }
  & taskkill /PID ([int]$State.supervisorPid) /T /F 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { throw '无法停止受管服务' }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ((Get-ListenerProcessIds 31900).Count -eq 0 -and (Get-ListenerProcessIds 31901).Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  if ((Get-ListenerProcessIds 31900).Count -gt 0 -or (Get-ListenerProcessIds 31901).Count -gt 0) {
    throw '旧服务端口未释放'
  }
  Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
}

function Write-ManagerState([string]$StatePath, $State) {
  $directory = Split-Path -Parent $StatePath
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$StatePath.tmp-$PID"
  [IO.File]::WriteAllText(
    $temporary,
    ($State | ConvertTo-Json),
    (New-Object Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

function Start-FormalStack([string]$Root, [string]$TargetRuntimeRoot, [string]$StatePath) {
  $logs = Join-Path $TargetRuntimeRoot 'logs'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logs "stack-$stamp.stdout.log"
  $stderrPath = Join-Path $logs "stack-$stamp.stderr.log"
  $stackScript = Join-Path $Root 'scripts\start-agent-stack.mjs'
  $nodePath = (Get-Command node -ErrorAction Stop).Source

  $process = Start-Process -FilePath $nodePath -ArgumentList @($stackScript, 'prod') `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $state = [ordered]@{
    supervisorPid = $process.Id
    supervisorStartTime = $process.StartTime.ToUniversalTime().ToString('O')
    worktree = [IO.Path]::GetFullPath($Root)
    version = (& git -C $Root rev-parse HEAD).Trim()
  }
  Write-ManagerState $StatePath $state

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if ($process.HasExited) { break }
    $webOk = Test-HttpOk 'http://127.0.0.1:31900/api/health'
    $agentOk = Test-HttpOk 'http://127.0.0.1:31901/health'
    if ($webOk -and $agentOk -and (Get-ListenerProcessIds 3000).Count -eq 0) {
      return $state
    }
    Start-Sleep -Milliseconds 300
    $process.Refresh()
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $process.HasExited) { & taskkill /PID $process.Id /T /F 1>$null 2>$null }
  Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
  throw "正式服务启动失败，请查看脱敏日志目录：$logs"
}

function Invoke-FormalStackManager {
  $resolvedRoot = [IO.Path]::GetFullPath($ProjectRoot)
  $resolvedRuntime = [IO.Path]::GetFullPath($RuntimeRoot)
  $configPath = Initialize-FormalConfig $resolvedRuntime
  $config = Read-StrictEnvFile $configPath
  Assert-FormalConfig $config
  Set-FormalEnvironment $config

  $preflight = Invoke-PostgresPreflight $resolvedRoot
  if ((Get-ListenerProcessIds 58258).Count -eq 0) { throw 'PostgreSQL 58258 未监听' }
  if ((Get-ListenerProcessIds 3000).Count -gt 0) { throw '禁止使用端口 3000' }

  $statePath = Join-Path $resolvedRuntime 'state\stack.json'
  $state = Read-ManagerState $statePath
  $owned = Test-ManagedStackIdentity $state $resolvedRoot
  $present = (Get-ListenerProcessIds 31900).Count -gt 0 -or (Get-ListenerProcessIds 31901).Count -gt 0
  $decision = Resolve-ManagedStackAction ([pscustomobject]@{
    active = [int]$preflight.active
    owned = $owned
    healthy = $present
  })

  switch ($decision.action) {
    'refuse-active' { throw '存在正在运行的分析任务，已拒绝重启' }
    'refuse-foreign' { throw '现有 Web/Agent 不属于本启动器，请先在原终端停止服务' }
    'restart' { Stop-OwnedStack $state $resolvedRoot $statePath }
    'replace-stale' {
      if ($state -and (Get-Process -Id ([int]$state.supervisorPid) -ErrorAction SilentlyContinue)) {
        Stop-OwnedStack $state $resolvedRoot $statePath
      } else {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $newState = Start-FormalStack $resolvedRoot $resolvedRuntime $statePath
  Invoke-PostgresPreflight $resolvedRoot | Out-Null
  Write-Host "[完成] 正式系统已启动：Web 31900 / Agent 31901 / PostgreSQL 58258"
  Write-Host "[版本] $($newState.version)"
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-FormalStackManager
}
