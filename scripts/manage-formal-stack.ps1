[CmdletBinding()]
param(
  [string]$ProjectRoot,
  [string]$SharedRoot,
  [string]$DataRoot,
  [string]$RuntimeRoot,
  [switch]$PublishCode
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { throw '无法定位正式系统目录' }
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($SharedRoot)) {
  $SharedRoot = 'C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime'
}
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path $SharedRoot 'data' }
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Join-Path $SharedRoot 'runtime' }

function Test-PathInside([string]$Parent, [string]$Candidate) {
  $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
  if ($resolvedCandidate.Equals($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $resolvedCandidate.StartsWith(
    $resolvedParent + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Resolve-FormalRoots {
  $resolvedCode = [IO.Path]::GetFullPath($ProjectRoot)
  $resolvedShared = [IO.Path]::GetFullPath($SharedRoot)
  $resolvedData = [IO.Path]::GetFullPath($DataRoot)
  $resolvedRuntime = [IO.Path]::GetFullPath($RuntimeRoot)
  foreach ($candidate in @($resolvedData, $resolvedRuntime)) {
    if (Test-PathInside $resolvedCode $candidate) {
      throw '正式数据目录和运行目录必须位于代码目录之外'
    }
  }
  return [pscustomobject]@{
    codeRoot = $resolvedCode
    sharedRoot = $resolvedShared
    dataRoot = $resolvedData
    runtimeRoot = $resolvedRuntime
    configPath = Join-Path $resolvedShared 'formal-stack.env'
  }
}

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
    'AGENT_DATA_ROOT'
    'AGENT_RUNTIME_ROOT'
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
  if ([int]$State.active -gt 0 -and [bool]$State.healthy) { return @{ action = 'refuse-active' } }
  if ([bool]$State.healthy -and -not [bool]$State.owned) { return @{ action = 'refuse-foreign' } }
  if ([bool]$State.owned -and [bool]$State.healthy) { return @{ action = 'restart' } }
  if ([bool]$State.owned) { return @{ action = 'replace-stale' } }
  return @{ action = 'start' }
}

function Initialize-FormalConfig([string]$TargetSharedRoot) {
  $target = Join-Path $TargetSharedRoot 'formal-stack.env'
  if (Test-Path -LiteralPath $target -PathType Leaf) { return $target }
  throw '共享正式配置不存在，请先完成受控配置迁移'
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

function Set-FormalWorktreeEnvironment([string]$Root) {
  $resolved = [IO.Path]::GetFullPath($Root)
  foreach ($relative in @('package.json', 'app\rufus-voc-data.ts', 'scripts\run-background-rebuild.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $resolved $relative) -PathType Leaf)) {
      throw '正式系统目录无效'
    }
  }
  [Environment]::SetEnvironmentVariable('AGENT_FORMAL_WORKTREE_ROOT', $resolved, 'Process')
}

function Set-FormalRootEnvironment([string]$ResolvedDataRoot, [string]$ResolvedRuntimeRoot) {
  [Environment]::SetEnvironmentVariable('AGENT_DATA_ROOT', $ResolvedDataRoot, 'Process')
  [Environment]::SetEnvironmentVariable('AGENT_RUNTIME_ROOT', $ResolvedRuntimeRoot, 'Process')
}

function Invoke-PostgresProbe([string]$Source) {
  $output = $Source | & node --input-type=module - 2>$null
  return [pscustomobject]@{
    ExitCode = [int]$LASTEXITCODE
    Output = @($output)
  }
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
    WITH dormant_sync_runs AS (
      -- Completed imports can retain the canonical, never-dispatched traffic placeholder.
      -- Preserve those records; any lease, attempt or additional stage still blocks publication.
      SELECT run.id
        FROM analysis_runs run
        JOIN sync_jobs job ON job.run_id = run.id
        JOIN run_stages stage ON stage.run_id = run.id
       WHERE run.status = 'queued' AND job.status = 'completed'
         AND job.project_id = run.project_id AND job.actor_id = run.created_by
         AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
         AND run.idempotency_key = job.job_id
         AND job.leased_by IS NULL AND job.lease_expires_at IS NULL
         AND stage.stage = 'traffic-analysis' AND stage.status = 'queued'
         AND stage.attempt_count = 0 AND stage.started_at IS NULL
         AND (SELECT count(*) FROM run_stages other WHERE other.run_id = run.id) = 1
         AND (SELECT count(*) FROM sync_jobs other WHERE other.run_id = run.id) = 1
         AND NOT EXISTS (SELECT 1 FROM job_attempts attempt WHERE attempt.stage_id = stage.id)
    )
    SELECT
      (SELECT count(*)::int FROM sync_jobs WHERE status IN ('queued', 'running')) +
      (SELECT count(*)::int FROM run_stages WHERE status IN ('queued', 'running')
        AND run_id NOT IN (SELECT id FROM dormant_sync_runs)) +
      (SELECT count(*)::int FROM job_attempts WHERE status IN ('queued', 'running')) +
      (SELECT count(*)::int FROM analysis_runs WHERE status IN ('queued', 'running')
        AND id NOT IN (SELECT id FROM dormant_sync_runs)) +
      (SELECT CASE WHEN EXISTS(SELECT 1 FROM market_analysis_steps WHERE status IN ('queued', 'running')) THEN 1 ELSE 0 END) AS active
  `);
  process.stdout.write(JSON.stringify({ ok: true, active: Number(rows[0]?.active ?? -1) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "POSTGRES_UNAVAILABLE" }));
  process.exitCode = 2;
} finally {
  await client.end().catch(() => {});
}
'@
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $probe = Invoke-PostgresProbe $source
    if ($probe.ExitCode -eq 0) {
      try {
        $result = @($probe.Output) | ConvertFrom-Json
        if ($result.ok -and [int]$result.active -ge 0) { return $result }
      } catch {}
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 500
  } while ($true)
  throw 'PostgreSQL 连接或活动任务检查失败'
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

function Test-ManagerStateRoots($State, [string]$CodeRoot, [string]$DataRoot, [string]$RuntimeRoot) {
  if (-not $State) { return $false }
  try {
    return (
      [IO.Path]::GetFullPath([string]$State.codeRoot) -eq [IO.Path]::GetFullPath($CodeRoot) -and
      [IO.Path]::GetFullPath([string]$State.dataRoot) -eq [IO.Path]::GetFullPath($DataRoot) -and
      [IO.Path]::GetFullPath([string]$State.runtimeRoot) -eq [IO.Path]::GetFullPath($RuntimeRoot)
    )
  } catch { return $false }
}

function Test-ManagedStackIdentity($State, [string]$Root, [string]$ExpectedDataRoot, [string]$ExpectedRuntimeRoot) {
  if (-not $State) { return $false }
  if (-not (Test-ManagerStateRoots $State $Root $ExpectedDataRoot $ExpectedRuntimeRoot)) { return $false }
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

function Invoke-StackTreeTermination([int]$ProcessId) {
  # Windows PowerShell 5 turns native stderr into errors even when redirected.
  # A child may already have exited while taskkill walks the process tree.
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    & taskkill.exe /PID $ProcessId /T /F 1>$null 2>$null
    return [int]$LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
}

function Stop-OwnedStack($State, [string]$Root, [string]$ExpectedDataRoot, [string]$ExpectedRuntimeRoot, [string]$StatePath, [ValidateRange(0, 60)][int]$StopTimeoutSeconds = 15) {
  if (-not (Test-ManagedStackIdentity $State $Root $ExpectedDataRoot $ExpectedRuntimeRoot)) {
    throw '现有服务不属于本启动器，已拒绝停止'
  }
  $stopExitCode = Invoke-StackTreeTermination ([int]$State.supervisorPid)
  $deadline = [DateTime]::UtcNow.AddSeconds($StopTimeoutSeconds)
  do {
    $supervisor = Get-Process -Id ([int]$State.supervisorPid) -ErrorAction SilentlyContinue
    $portsReleased = (Get-ListenerProcessIds 31900).Count -eq 0 -and (Get-ListenerProcessIds 31901).Count -eq 0
    if (-not $supervisor -and $portsReleased) {
      Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
      return
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  } while ($true)
  if ($supervisor) { throw "旧服务主进程未退出（taskkill 返回码：$stopExitCode），已保留状态记录" }
  throw "旧服务端口未释放（taskkill 返回码：$stopExitCode），已保留状态记录"
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

function New-ManagerState(
  [int]$SupervisorPid,
  [string]$SupervisorStartTime,
  [string]$CodeRoot,
  [string]$DataRoot,
  [string]$RuntimeRoot,
  [string]$Commit
) {
  return [ordered]@{
    supervisorPid = $SupervisorPid
    supervisorStartTime = $SupervisorStartTime
    worktree = [IO.Path]::GetFullPath($CodeRoot)
    version = $Commit
    codeRoot = [IO.Path]::GetFullPath($CodeRoot)
    dataRoot = [IO.Path]::GetFullPath($DataRoot)
    runtimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
    commit = $Commit
  }
}

function Start-FormalStack([string]$Root, [string]$TargetDataRoot, [string]$TargetRuntimeRoot, [string]$Commit, [string]$StatePath, [switch]$RequireSourceMatch) {
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
  $state = New-ManagerState `
    -SupervisorPid $process.Id `
    -SupervisorStartTime $process.StartTime.ToUniversalTime().ToString('O') `
    -CodeRoot $Root `
    -DataRoot $TargetDataRoot `
    -RuntimeRoot $TargetRuntimeRoot `
    -Commit $Commit
  Write-ManagerState $StatePath $state

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if ($process.HasExited) { break }
    $webOk = Test-HttpOk 'http://127.0.0.1:31900/api/health'
    $agentOk = Test-HttpOk 'http://127.0.0.1:31901/health'
    if ($webOk -and $agentOk -and (Get-ListenerProcessIds 3000).Count -eq 0) {
      if (-not $RequireSourceMatch) { return $state }
      try {
        $web = Read-CodeRuntimeHealth 'http://127.0.0.1:31900/api/health'
        $agent = Read-CodeRuntimeHealth 'http://127.0.0.1:31901/health'
        if (Test-CodeSourceMatch $web $agent $Commit) { return $state }
      } catch {}
    }
    Start-Sleep -Milliseconds 300
    $process.Refresh()
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $process.HasExited) { Invoke-StackTreeTermination $process.Id | Out-Null }
  Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
  throw "正式服务启动失败，请查看脱敏日志目录：$logs"
}

function Invoke-CodePublication([string]$Root, [string]$Mode, [string]$ArtifactId) {
  $arguments = @((Join-Path $Root 'scripts\publish-code-web.mjs'), $Mode)
  if ($ArtifactId) { $arguments += $ArtifactId }
  Push-Location -LiteralPath $Root
  try {
    $output = & node @arguments
    if ($LASTEXITCODE -ne 0) { throw '代码发布操作失败' }
    return ($output | ConvertFrom-Json)
  } finally { Pop-Location }
}

function Assert-CodePublicationQueueIdle([string]$Root) {
  foreach ($directory in @('pending', 'processing')) {
    $queue = Join-Path $Root "data\web-reload-requests\$directory"
    if (Test-Path -LiteralPath $queue) {
      if (@(Get-ChildItem -LiteralPath $queue -Filter '*.json' -File -Force).Count -gt 0) { throw '存在 Web 发布交接，已拒绝代码更新' }
    }
  }
}

function Read-CodeRuntimeHealth([string]$Url) {
  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0
  if ($response.Content.Length -gt 16384) { throw '版本健康响应无效' }
  return ($response.Content | ConvertFrom-Json)
}

function Test-CodeReleaseMatch($Actual, $Expected) {
  return ($null -ne $Actual -and $null -ne $Expected -and
    $Actual.sourceCommit -cmatch '^[a-f0-9]{40}$' -and $Actual.sourceHash -cmatch '^[a-f0-9]{64}$' -and
    $Actual.baseArtifactId -cmatch '^[a-f0-9]{64}$' -and
    $Actual.sourceCommit -ceq $Expected.sourceCommit -and $Actual.sourceHash -ceq $Expected.sourceHash -and
    $Actual.baseArtifactId -ceq $Expected.baseArtifactId)
}

function Test-CodeSourceMatch($Web, $Agent, [string]$ExpectedCommit) {
  return ($null -ne $Web -and $null -ne $Agent -and
    $Web.status -eq 'ok' -and $Agent.status -eq 'ok' -and
    $Web.codeSource.sourceCommit -cmatch '^[a-f0-9]{40}$' -and
    $Web.codeSource.sourceHash -cmatch '^[a-f0-9]{64}$' -and
    $Web.codeSource.sourceCommit -ceq $ExpectedCommit -and
    $Agent.codeSource.sourceCommit -ceq $Web.codeSource.sourceCommit -and
    $Agent.codeSource.sourceHash -ceq $Web.codeSource.sourceHash)
}

function Wait-CodePublication([string]$Root, $Prepared, [int]$TimeoutSeconds = 90) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $status = Invoke-CodePublication $Root 'status' $Prepared.artifactId
    if ($status.status -eq 'failed') { throw '代码版本激活失败，已保留已知可用版本' }
    if ($status.status -eq 'applied' -and $status.artifactId -ceq $Prepared.artifactId -and
      $status.requestId -ceq $Prepared.requestId -and (Test-CodeReleaseMatch $status.codeRelease $Prepared.codeRelease)) {
      $web = Read-CodeRuntimeHealth 'http://127.0.0.1:31900/api/health'
      $agent = Read-CodeRuntimeHealth 'http://127.0.0.1:31901/health'
      if ($web.status -eq 'ok' -and $agent.status -eq 'ok' -and $web.artifactId -ceq $Prepared.artifactId -and
        (Test-CodeReleaseMatch $web.codeRelease $Prepared.codeRelease) -and
        $agent.codeSource.sourceCommit -ceq $Prepared.codeRelease.sourceCommit -and
        $agent.codeSource.sourceHash -ceq $Prepared.codeRelease.sourceHash) { return $status }
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 300
  } while ($true)
  throw '代码版本未获得精确激活确认'
}

function Invoke-FormalStackManager {
  $roots = Resolve-FormalRoots
  $resolvedRoot = $roots.codeRoot
  $resolvedData = $roots.dataRoot
  $resolvedRuntime = $roots.runtimeRoot
  $configPath = Initialize-FormalConfig $roots.sharedRoot
  $config = Read-StrictEnvFile $configPath
  Assert-FormalConfig $config
  if (
    [IO.Path]::GetFullPath([string]$config.AGENT_DATA_ROOT) -ne $resolvedData -or
    [IO.Path]::GetFullPath([string]$config.AGENT_RUNTIME_ROOT) -ne $resolvedRuntime
  ) { throw '正式数据目录配置与启动参数不一致' }
  Set-FormalEnvironment $config
  Set-FormalWorktreeEnvironment $resolvedRoot
  Set-FormalRootEnvironment $resolvedData $resolvedRuntime

  $preflight = Invoke-PostgresPreflight $resolvedRoot
  if ((Get-ListenerProcessIds 58258).Count -eq 0) { throw 'PostgreSQL 58258 未监听' }
  if ((Get-ListenerProcessIds 3000).Count -gt 0) { throw '禁止使用端口 3000' }

  $statePath = Join-Path $resolvedRuntime 'state\stack.json'
  $state = Read-ManagerState $statePath
  $owned = Test-ManagedStackIdentity $state $resolvedRoot $resolvedData $resolvedRuntime
  $present = (Get-ListenerProcessIds 31900).Count -gt 0 -or (Get-ListenerProcessIds 31901).Count -gt 0
  $decision = Resolve-ManagedStackAction ([pscustomobject]@{
    active = [int]$preflight.active
    owned = $owned
    healthy = $present
  })

  $prepared = $null
  if ($PublishCode) {
    if ($decision.action -ne 'restart' -or -not (Test-HttpOk 'http://127.0.0.1:31900/api/health') -or
      -not (Test-HttpOk 'http://127.0.0.1:31901/health')) { throw '代码更新需要空闲且健康的受管服务' }
    Assert-CodePublicationQueueIdle $resolvedRoot
    $prepared = Invoke-CodePublication $resolvedRoot 'prepare'
    if ($prepared.status -ne 'prepared' -or $prepared.artifactId -cnotmatch '^[a-f0-9]{64}$' -or
      $prepared.requestId -cnotmatch '^[a-f0-9]{64}$' -or -not (Test-CodeReleaseMatch $prepared.codeRelease $prepared.codeRelease)) { throw '代码准备身份无效' }
    # The build can take minutes: every live stop gate is checked again afterwards.
    $preflight = Invoke-PostgresPreflight $resolvedRoot
    $state = Read-ManagerState $statePath
    if ([int]$preflight.active -ne 0 -or -not (Test-ManagedStackIdentity $state $resolvedRoot $resolvedData $resolvedRuntime) -or
      -not (Test-HttpOk 'http://127.0.0.1:31900/api/health') -or -not (Test-HttpOk 'http://127.0.0.1:31901/health') -or
      (Get-ListenerProcessIds 58258).Count -eq 0 -or (Get-ListenerProcessIds 3000).Count -gt 0) { throw '构建后运行状态变化，已拒绝代码更新' }
    Assert-CodePublicationQueueIdle $resolvedRoot
  }

  if (-not $PublishCode -and $decision.action -eq 'restart') {
    $expectedCommit = (& git -C $resolvedRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $expectedCommit -cnotmatch '^[a-f0-9]{40}$') { throw '无法解析正式代码版本' }
    $web = Read-CodeRuntimeHealth 'http://127.0.0.1:31900/api/health'
    $agent = Read-CodeRuntimeHealth 'http://127.0.0.1:31901/health'
    if (-not (Test-CodeSourceMatch $web $agent $expectedCommit)) {
      throw '现有服务源码身份不匹配，已保留运行中的服务'
    }
  }

  switch ($decision.action) {
    'refuse-active' { throw '存在正在运行的分析任务，已拒绝重启' }
    'refuse-foreign' { throw '现有 Web/Agent 不属于本启动器，请先在原终端停止服务' }
    'restart' { Stop-OwnedStack $state $resolvedRoot $resolvedData $resolvedRuntime $statePath }
    'replace-stale' {
      if ($state -and (Get-Process -Id ([int]$state.supervisorPid) -ErrorAction SilentlyContinue)) {
        Stop-OwnedStack $state $resolvedRoot $resolvedData $resolvedRuntime $statePath
      } else {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $commit = (& git -C $resolvedRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) { throw '无法解析正式代码版本' }
  $newState = Start-FormalStack $resolvedRoot $resolvedData $resolvedRuntime $commit $statePath -RequireSourceMatch:(-not $PublishCode)
  if ($prepared) {
    $agent = Read-CodeRuntimeHealth 'http://127.0.0.1:31901/health'
    if ($newState.commit -cne $prepared.codeRelease.sourceCommit -or $agent.status -ne 'ok' -or
      $agent.codeSource.sourceCommit -cne $prepared.codeRelease.sourceCommit -or
      $agent.codeSource.sourceHash -cne $prepared.codeRelease.sourceHash) { throw '新服务源码身份不匹配，未提交代码请求' }
    $submitted = Invoke-CodePublication $resolvedRoot 'submit' $prepared.artifactId
    if ($submitted.status -notin @('pending', 'applied') -or $submitted.artifactId -cne $prepared.artifactId -or
      $submitted.requestId -cne $prepared.requestId -or -not (Test-CodeReleaseMatch $submitted.codeRelease $prepared.codeRelease)) { throw '代码发布交接失败' }
    Wait-CodePublication $resolvedRoot $prepared | Out-Null
  }
  Invoke-PostgresPreflight $resolvedRoot | Out-Null
  Write-Host "[完成] 正式系统已启动：Web 31900 / Agent 31901 / PostgreSQL 58258"
  Write-Host "[版本] $($newState.commit)"
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-FormalStackManager
}
