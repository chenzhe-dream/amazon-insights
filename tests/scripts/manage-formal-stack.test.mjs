import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const managerPath = path.join(root, "scripts", "manage-formal-stack.ps1");

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function invokePowerShell(command) {
  return spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `$ErrorActionPreference='Stop'; . ${psLiteral(managerPath)}; ${command}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function invokeDecision({ owned, healthy, active }) {
  const command = [
    `$state=[pscustomobject]@{owned=$${owned};healthy=$${healthy};active=${active}}`,
    "Resolve-ManagedStackAction $state | ConvertTo-Json -Compress",
  ].join("; ");
  const result = invokePowerShell(command);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

for (const scenario of ["success", "prepare-failure", "active-after-build", "foreign-after-build", "activation-failure", "wrong-runtime-identity", "old-supervisor", "default"]) {
  test(`code manager guarded handoff: ${scenario}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "code-manager-"));
    const dataRoot = path.join(directory, "data"), runtimeRoot = path.join(directory, "runtime");
    await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
    await writeFile(path.join(directory, "formal-stack.env"), [
      "AGENT_DATABASE_URL=postgresql://unused", "AGENT_VOC_LOCAL_FAKE=0", "WEB_HOST=0.0.0.0", "WEB_PORT=31900",
      "AGENT_SERVICE_HOST=127.0.0.1", "AGENT_SERVICE_PORT=31901", "AGENT_SERVICE_INTERNAL_URL=http://127.0.0.1:31901",
      "AGENT_SERVICE_TRUSTED_ORIGINS=http://127.0.0.1:31900", "AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=1",
      `AGENT_DATA_ROOT=${dataRoot}`, `AGENT_RUNTIME_ROOT=${runtimeRoot}`,
    ].join("\n"));
    await writeFile(path.join(runtimeRoot, "state", "stack.json"), JSON.stringify({ supervisorPid: 123 }));
    try {
      const result = invokePowerShell(`
        $ProjectRoot=${psLiteral(root)}; $SharedRoot=${psLiteral(directory)}; $DataRoot=${psLiteral(dataRoot)}; $RuntimeRoot=${psLiteral(runtimeRoot)}
        $PublishCode=$${scenario !== "default"}; $script:events=@(); $script:prepared=$false
        function Invoke-PostgresPreflight { if ($script:prepared -and '${scenario}' -eq 'active-after-build') { return @{active=1} }; return @{active=0} }
        function Get-ListenerProcessIds([int]$Port) { if ($Port -eq 3000) { return @() }; return @(123) }
        function Test-ManagedStackIdentity { return -not ($script:prepared -and '${scenario}' -eq 'foreign-after-build') }
        function Test-HttpOk { return $true }
        function Stop-OwnedStack { $script:events += 'stop' }
        function Start-FormalStack { $script:events += 'start'; return @{commit=('c'*40)} }
        function Invoke-CodePublication([string]$Root, [string]$Mode, [string]$ArtifactId) {
          $script:events += $Mode
          if ($Mode -eq 'prepare') { if ('${scenario}' -eq 'prepare-failure') { throw 'prepare failed' }; $script:prepared=$true }
          $status=if($Mode -eq 'prepare'){'prepared'}elseif($Mode -eq 'submit'){'pending'}elseif('${scenario}' -eq 'activation-failure'){'failed'}else{'applied'}
          return @{status=$status;artifactId=('a'*64);kind='code';requestId=('d'*64);codeRelease=@{sourceCommit=('c'*40);sourceHash=('b'*64);baseArtifactId=('e'*64)}}
        }
        function Read-CodeRuntimeHealth([string]$Url) {
          if ('${scenario}' -eq 'old-supervisor') { return @{status='ok'} }
          $hash=if('${scenario}' -eq 'wrong-runtime-identity'){'f'*64}else{'b'*64}
          return @{status='ok';artifactId=('a'*64);codeRelease=@{sourceCommit=('c'*40);sourceHash=$hash;baseArtifactId=('e'*64)};codeSource=@{sourceCommit=('c'*40);sourceHash=('b'*64)}}
        }
        $script:realWait = (Get-Command Wait-CodePublication).ScriptBlock
        function Wait-CodePublication { & $script:realWait @args -TimeoutSeconds 0 }
        $failed=$false
        try { Invoke-FormalStackManager *> $null } catch { $failed=$true }
        @{failed=$failed;events=@($script:events)} | ConvertTo-Json -Compress
      `);
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout.trim());
      assert.equal(observed.failed, !["success", "default"].includes(scenario));
      if (["prepare-failure", "active-after-build", "foreign-after-build"].includes(scenario)) assert.deepEqual(observed.events, ["prepare"]);
      else if (scenario === "default") assert.deepEqual(observed.events, ["stop", "start"]);
      else if (scenario === "old-supervisor") assert.deepEqual(observed.events, ["prepare", "stop", "start"]);
      else assert.deepEqual(observed.events, ["prepare", "stop", "start", "submit", "status"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("missing configuration fails closed", () => {
  const missing = path.join(os.tmpdir(), `formal-stack-missing-${process.pid}.env`);
  const result = invokePowerShell(`Read-StrictEnvFile ${psLiteral(missing)} | Out-Null`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /正式配置文件不存在/);
});

test("missing shared formal config fails closed and requires explicit migration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "formal-stack-shared-missing-"));
  const sharedRoot = path.join(directory, "shared");
  try {
    const result = invokePowerShell(
      `Initialize-FormalConfig ${psLiteral(sharedRoot)} | Out-Null`,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /迁移/);
    await assert.rejects(readFile(path.join(sharedRoot, "formal-stack.env"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("script resolves its root after parameter binding for Windows PowerShell 5", async () => {
  const source = await readFile(managerPath, "utf8");
  const parameterBlock = source.slice(0, source.indexOf("$ErrorActionPreference"));
  assert.doesNotMatch(parameterBlock, /\$PSScriptRoot/);
  assert.match(
    source,
    /if \(\[string\]::IsNullOrWhiteSpace\(\$ProjectRoot\)\)[\s\S]*?Split-Path -Parent \$PSScriptRoot/,
  );
  assert.doesNotMatch(source, /GetRelativePath/);
});

test("strict env parser preserves values containing equals signs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "formal-stack-env-"));
  const envPath = path.join(directory, "formal-stack.env");
  await writeFile(envPath, "AGENT_DATABASE_URL=postgresql://user:p=a@localhost/app\n", "utf8");
  try {
    const result = invokePowerShell(
      `(Read-StrictEnvFile ${psLiteral(envPath)})['AGENT_DATABASE_URL']`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "postgresql://user:p=a@localhost/app");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("healthy owned stack with no active work resolves to restart", () => {
  assert.deepEqual(invokeDecision({ owned: true, healthy: true, active: 0 }), {
    action: "restart",
  });
});

test("active work refuses restart", () => {
  assert.deepEqual(invokeDecision({ owned: true, healthy: true, active: 1 }), {
    action: "refuse-active",
  });
});

test("stopped stack starts to resume queued work", () => {
  assert.deepEqual(invokeDecision({ owned: false, healthy: false, active: 1 }), {
    action: "start",
  });
});

test("healthy foreign port owner fails closed", () => {
  assert.deepEqual(invokeDecision({ owned: false, healthy: true, active: 0 }), {
    action: "refuse-foreign",
  });
});

test("JSON-restored UTC DateTime matches the observed process start without local offset drift", () => {
  const result = invokePowerShell(
    "$stored=('{\"started\":\"2026-08-27T16:03:38.0055807Z\"}' | ConvertFrom-Json).started; $observed=[DateTime]::Parse('2026-08-27T16:03:38.0055807Z').ToUniversalTime(); Test-ProcessStartTimeMatch $observed $stored",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "True");
});

test("formal config rejects fake mode and accepts the exact production boundary", async () => {
  const config = (fake) =>
    `$config=@{AGENT_VOC_LOCAL_FAKE='${fake}';WEB_HOST='0.0.0.0';WEB_PORT='31900';AGENT_SERVICE_HOST='127.0.0.1';AGENT_SERVICE_PORT='31901';AGENT_SERVICE_INTERNAL_URL='http://127.0.0.1:31901';AGENT_SERVICE_TRUSTED_ORIGINS='http://192.168.1.109:31900,http://127.0.0.1:31900';AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE='1';AGENT_DATABASE_URL='postgresql://redacted';AGENT_DATA_ROOT='C:\\runtime\\data';AGENT_RUNTIME_ROOT='C:\\runtime\\runtime'}; Assert-FormalConfig $config`;
  const invalid = invokePowerShell(
    config("1"),
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /正式 fake 模式必须关闭/);

  const valid = invokePowerShell(
    config("0"),
  );
  assert.equal(valid.status, 0, valid.stderr);
});

test("formal launcher exports the validated worktree root to supervisor children", () => {
  const expected = path.resolve(root);
  const result = invokePowerShell(
    `Set-FormalWorktreeEnvironment ${psLiteral(expected)}; [Environment]::GetEnvironmentVariable('AGENT_FORMAL_WORKTREE_ROOT', 'Process')`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(path.resolve(result.stdout.trim()), expected);
});

test("formal manager defaults data, runtime, and env config beneath the canonical shared root", () => {
  const result = invokePowerShell(
    "Resolve-FormalRoots | ConvertTo-Json -Compress",
  );
  assert.equal(result.status, 0, result.stderr);
  const roots = JSON.parse(result.stdout.trim());
  const sharedRoot = path.resolve("C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime");
  assert.equal(path.resolve(roots.sharedRoot), sharedRoot);
  assert.equal(path.resolve(roots.dataRoot), path.join(sharedRoot, "data"));
  assert.equal(path.resolve(roots.runtimeRoot), path.join(sharedRoot, "runtime"));
  assert.equal(path.resolve(roots.configPath), path.join(sharedRoot, "formal-stack.env"));
});

test("manager state adds canonical root identity and commit without dropping compatibility fields", () => {
  const codeRoot = path.resolve(root);
  const sharedRoot = path.resolve(os.tmpdir(), "canonical-runtime-state");
  const dataRoot = path.join(sharedRoot, "data");
  const runtimeRoot = path.join(sharedRoot, "runtime");
  const commit = "b".repeat(40);
  const command = [
    `$state=New-ManagerState -SupervisorPid 123 -SupervisorStartTime '2026-09-01T00:00:00.0000000Z' -CodeRoot ${psLiteral(codeRoot)} -DataRoot ${psLiteral(dataRoot)} -RuntimeRoot ${psLiteral(runtimeRoot)} -Commit ${psLiteral(commit)}`,
    "$state | ConvertTo-Json -Compress",
  ].join("; ");
  const result = invokePowerShell(command);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout.trim());
  assert.equal(state.supervisorPid, 123);
  assert.equal(state.worktree, codeRoot);
  assert.equal(state.version, commit);
  assert.equal(state.commit, commit);
  assert.equal(state.codeRoot, codeRoot);
  assert.equal(state.dataRoot, dataRoot);
  assert.equal(state.runtimeRoot, runtimeRoot);
});

test("manager state root mismatch is visible and fails identity validation", () => {
  const expectedData = path.resolve("C:/runtime/data");
  const expectedRuntime = path.resolve("C:/runtime/runtime");
  const command = [
    `$state=[pscustomobject]@{codeRoot=${psLiteral(root)};dataRoot='C:\\other\\data';runtimeRoot=${psLiteral(expectedRuntime)}}`,
    `Test-ManagerStateRoots $state ${psLiteral(root)} ${psLiteral(expectedData)} ${psLiteral(expectedRuntime)}`,
  ].join("; ");
  const result = invokePowerShell(command);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "False");
});

test("VSCode exposes the Python launcher through the Run button and runtime state is ignored", async () => {
  const launch = JSON.parse(await readFile(path.join(root, ".vscode", "launch.json"), "utf8"));
  assert.deepEqual(launch.configurations.map((entry) => entry.name), ["启动/重启正式系统"]);
  assert.equal(launch.configurations[0].type, "debugpy");
  assert.match(launch.configurations[0].program, /launcher\/main\.py$/);
  await assert.rejects(readFile(path.join(root, ".vscode", "tasks.json"), "utf8"), {
    code: "ENOENT",
  });
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /^\/\.runtime\/$/m);
});
