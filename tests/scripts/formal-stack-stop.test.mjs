import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const literal = value => `'${value.replaceAll("'", "''")}'`;

for (const shell of ['powershell.exe', 'pwsh']) {
  for (const scenario of ['exited-with-stderr', 'supervisor-alive', 'port-busy', 'foreign']) {
    test(`${shell}: managed stop ${scenario}`, { skip: process.platform !== 'win32' }, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'formal-stop-'));
      try {
        const result = spawnSync(shell, ['-NoProfile', '-Command', `
          $ErrorActionPreference='Stop'
          . ${literal(path.join(root, 'scripts/manage-formal-stack.ps1'))}
          $statePath=${literal(path.join(directory, 'stack.json'))}
          [IO.File]::WriteAllText($statePath, '{}')
          $script:killCalls=0
          function Test-ManagedStackIdentity { return ('${scenario}' -ne 'foreign') }
          function taskkill.exe {
            $script:killCalls++
            if ('${scenario}' -eq 'exited-with-stderr') {
              & $env:ComSpec /d /c 'echo child already exited 1>&2 & exit /b 128'
            } else { & $env:ComSpec /d /c 'exit /b 0' }
          }
          function taskkill { taskkill.exe @args }
          function Get-Process { if ('${scenario}' -eq 'supervisor-alive') { return @{Id=123} } }
          function Get-ListenerProcessIds { if ('${scenario}' -eq 'port-busy') { return @(456) }; return @() }
          $failed=$false
          try { Stop-OwnedStack @{supervisorPid=123} 'code' 'data' 'runtime' $statePath -StopTimeoutSeconds 0 }
          catch { $failed=$true }
          @{failed=$failed;stateExists=(Test-Path -LiteralPath $statePath);killCalls=$script:killCalls;preference=[string]$ErrorActionPreference} | ConvertTo-Json -Compress
        `], { cwd: root, encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, result.stderr);
        const observed = JSON.parse(result.stdout.trim());
        const shouldFail = scenario !== 'exited-with-stderr';
        assert.deepEqual(observed, {
          failed: shouldFail,
          stateExists: shouldFail,
          killCalls: scenario === 'foreign' ? 0 : 1,
          preference: 'Stop',
        });
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}
