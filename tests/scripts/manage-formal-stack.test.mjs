import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("missing configuration fails closed", () => {
  const missing = path.join(os.tmpdir(), `formal-stack-missing-${process.pid}.env`);
  const result = invokePowerShell(`Read-StrictEnvFile ${psLiteral(missing)} | Out-Null`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /正式配置文件不存在/);
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
    `$config=@{AGENT_VOC_LOCAL_FAKE='${fake}';WEB_HOST='0.0.0.0';WEB_PORT='31900';AGENT_SERVICE_HOST='127.0.0.1';AGENT_SERVICE_PORT='31901';AGENT_SERVICE_INTERNAL_URL='http://127.0.0.1:31901';AGENT_SERVICE_TRUSTED_ORIGINS='http://192.168.1.109:31900,http://127.0.0.1:31900';AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE='1';AGENT_DATABASE_URL='postgresql://redacted'}; Assert-FormalConfig $config`;
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
