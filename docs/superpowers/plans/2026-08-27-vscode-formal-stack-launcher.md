# VSCode Formal Stack Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one VSCode Run-button entry that safely starts or restarts the formal Web/Agent stack with fixed protected configuration.

**Architecture:** A PowerShell manager owns configuration migration, active-work preflight, managed-process identity, detached startup, restart and health verification. A minimal `launcher/main.py` wrapper and `.vscode/launch.json` expose the normal VSCode Run button; `.runtime/` contains ignored secrets, state and logs.

**Tech Stack:** PowerShell 7, Node.js >=22.13, VSCode Tasks, Node test runner, PostgreSQL.

## Global Constraints

- Continue to call `scripts/start-agent-stack.mjs prod`; do not change business startup behavior.
- Do not build, submit analysis work, call Providers, or mutate business data.
- Never print or commit database URLs, Provider keys, proxy tokens, cookies, headers, or request bodies.
- Only stop a process tree whose PID, start time, command and absolute worktree match the manager state.
- Refuse restart when any job, stage, attempt, or run is queued or running.
- Keep PostgreSQL running and require ports 31900/31901/58258 healthy with port 3000 absent.
- Preserve all existing generated application and project JSON WIP.

---

### Task 1: Formal stack manager

**Files:**
- Create: `scripts/manage-formal-stack.ps1`
- Test: `tests/scripts/manage-formal-stack.test.mjs`

**Interfaces:**
- Consumes: existing `scripts/start-agent-stack.mjs prod`, protected PostgreSQL credential file, and repository `.env.local`.
- Produces: `Invoke-FormalStackManager`, `Read-StrictEnvFile`, `Resolve-ManagedStackAction`, and ignored `.runtime/formal-stack.env`, `.runtime/state/stack.json`, `.runtime/logs/*`.

- [ ] **Step 1: Write failing PowerShell contract tests**

```js
test("missing configuration fails closed", () => {
  const result = invokePowerShell("Read-StrictEnvFile $env:TEST_ENV_PATH");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /配置文件不存在/);
});

test("healthy owned stack with no active work resolves to restart", () => {
  const result = invokeDecision({ owned: true, healthy: true, active: 0 });
  assert.deepEqual(result, { action: "restart" });
});

test("active work refuses restart", () => {
  const result = invokeDecision({ owned: true, healthy: true, active: 1 });
  assert.deepEqual(result, { action: "refuse-active" });
});

test("foreign port owner fails closed", () => {
  const result = invokeDecision({ owned: false, healthy: true, active: 0 });
  assert.deepEqual(result, { action: "refuse-foreign" });
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/scripts/manage-formal-stack.test.mjs`

Expected: FAIL because `scripts/manage-formal-stack.ps1` and its functions do not exist.

- [ ] **Step 3: Implement strict configuration and pure decision functions**

```powershell
function Read-StrictEnvFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw '正式配置文件不存在' }
  $result = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0])) { throw '正式配置格式无效' }
    $result[$parts[0].Trim()] = $parts[1]
  }
  return $result
}

function Resolve-ManagedStackAction($State) {
  if ($State.active -gt 0) { return @{ action = 'refuse-active' } }
  if ($State.healthy -and -not $State.owned) { return @{ action = 'refuse-foreign' } }
  if ($State.owned -and $State.healthy) { return @{ action = 'restart' } }
  if ($State.owned) { return @{ action = 'replace-stale' } }
  return @{ action = 'start' }
}
```

- [ ] **Step 4: Implement configuration bootstrap and no-secret database preflight**

```powershell
function Initialize-FormalConfig([string]$RuntimeRoot) {
  $target = Join-Path $RuntimeRoot 'formal-stack.env'
  if (Test-Path -LiteralPath $target) { return $target }
  $source = 'C:\Users\EDY\AppData\Local\Temp\amazon-insights-postgres-credentials-20260820-094538.env'
  $database = @(Get-Content -LiteralPath $source | Where-Object { $_ -like 'AGENT_DATABASE_URL=*' })
  if ($database.Count -ne 1) { throw '受保护的 PostgreSQL 配置不可用' }
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  @(
    'NODE_ENV=development', 'WEB_HOST=0.0.0.0', 'WEB_PORT=31900',
    'AGENT_SERVICE_HOST=127.0.0.1', 'AGENT_SERVICE_PORT=31901',
    'AGENT_SERVICE_INTERNAL_URL=http://127.0.0.1:31901',
    'AGENT_VOC_LOCAL_FAKE=0', $database[0]
  ) | Set-Content -LiteralPath $target -Encoding utf8NoBOM
  return $target
}
```

The active-work query must return only an integer sum across `sync_jobs`, `run_stages`, `job_attempts`, and `analysis_runs` with statuses `queued` or `running`; it must never print the connection string.

- [ ] **Step 5: Implement managed identity, restart, detached launch and health gates**

```powershell
$process = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList @((Join-Path $ProjectRoot 'scripts/start-agent-stack.mjs'), 'prod') `
  -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$state = [ordered]@{
  supervisorPid = $process.Id
  supervisorStartTime = $process.StartTime.ToUniversalTime().ToString('O')
  worktree = $ProjectRoot
  version = (git -C $ProjectRoot rev-parse HEAD).Trim()
}
```

Before `taskkill /PID <owned-pid> /T /F`, verify the stored start time, exact absolute worktree, and command line. After launch, wait up to 30 seconds for Web and Agent HTTP 200, PostgreSQL query success, and port 3000 absence; otherwise terminate only the new owned tree and exit nonzero.

- [ ] **Step 6: Run GREEN and regression tests**

Run: `node --test tests/scripts/manage-formal-stack.test.mjs tests/scripts/start-agent-stack.test.mjs`

Expected: PASS with no real service start, Provider call, or business write.

- [ ] **Step 7: Commit Task 1**

```powershell
git add scripts/manage-formal-stack.ps1 tests/scripts/manage-formal-stack.test.mjs
git commit -m "feat: add formal stack manager"
```

### Task 2: VSCode one-click entry and runtime boundary

**Files:**
- Create: `.vscode/launch.json`
- Create: `launcher/main.py`
- Modify: `.gitignore`
- Test: `tests/scripts/manage-formal-stack.test.mjs`
- Test: `tests/scripts/test_launcher_main.py`

**Interfaces:**
- Consumes: `scripts/manage-formal-stack.ps1`.
- Produces: VSCode Run configuration `启动/重启正式系统`; ignores `/.runtime/`.

- [ ] **Step 1: Add failing task-boundary assertions**

```js
test("VSCode exposes the Python launcher through the Run button", async () => {
  const launch = JSON.parse(await readFile(".vscode/launch.json", "utf8"));
  assert.deepEqual(launch.configurations.map((entry) => entry.name), ["启动/重启正式系统"]);
  assert.match(launch.configurations[0].program, /launcher\/main\.py$/);
  assert.match(await readFile(".gitignore", "utf8"), /^\/\.runtime\/$/m);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/scripts/manage-formal-stack.test.mjs`

Expected: FAIL because `.vscode/launch.json`, `launcher/main.py`, and the ignore rule do not exist.

- [ ] **Step 3: Add the Python wrapper, VSCode Run configuration, and ignore rule**

```json
{
  "version": "0.2.0",
  "configurations": [{
    "name": "启动/重启正式系统",
    "type": "debugpy",
    "request": "launch",
    "program": "${workspaceFolder}/launcher/main.py",
    "console": "integratedTerminal"
  }]
}
```

Add `/.runtime/` to `.gitignore`.

- [ ] **Step 4: Run GREEN, lint and diff checks**

Run: `node --test tests/scripts/manage-formal-stack.test.mjs tests/scripts/start-agent-stack.test.mjs`

Expected: PASS.

Run: `git diff --check -- .gitignore .vscode/launch.json launcher/main.py scripts/manage-formal-stack.ps1 tests/scripts/manage-formal-stack.test.mjs tests/scripts/test_launcher_main.py`

Expected: exit 0.

- [ ] **Step 5: Commit Task 2**

```powershell
git add .gitignore .vscode/launch.json launcher/main.py tests/scripts/manage-formal-stack.test.mjs tests/scripts/test_launcher_main.py
git commit -m "feat: add vscode formal stack run button"
```

### Task 3: Safe local acceptance

**Files:**
- Runtime only: `.runtime/formal-stack.env`, `.runtime/state/stack.json`, `.runtime/logs/*`
- Verify: no source changes.

**Interfaces:**
- Consumes: completed Tasks 1-2 and current protected credential source.
- Produces: one healthy managed supervisor independent of the VSCode run terminal.

- [ ] **Step 1: Verify source and WIP boundary**

Run: `git status --short` and `git diff --cached --name-only`.

Expected: protected generated WIP unchanged; index empty; `.runtime/` absent from status.

- [ ] **Step 2: Run the manager only after active work is zero**

Run: `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage-formal-stack.ps1`

Expected: configuration initialized without secret output, active count zero, one supervisor started or restarted.

- [ ] **Step 3: Verify health and persistence**

Run read-only checks for Web 31900 HTTP 200, Agent 31901 HTTP 200, PostgreSQL 58258 query success, port 3000 absent, one owned supervisor, `AGENT_VOC_LOCAL_FAKE=0`, and current artifact identity.

Expected: all gates pass after the launching terminal exits.

- [ ] **Step 4: Verify second-click behavior without business work**

Run the same manager once more while active count remains zero.

Expected: the prior owned tree stops, exactly one new owned supervisor starts, all health gates pass, and no job/run/stage or Provider activity is created.

- [ ] **Step 5: Final review**

Review only this plan's diff for Critical issues, unsafe process ownership, secret disclosure, active-work interruption, or failure to persist outside the VSCode run terminal.
