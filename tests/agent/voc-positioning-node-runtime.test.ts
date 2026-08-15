import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("ordinary Node imports and executes VOC positioning without React conditions", () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const executed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-name-pattern=full scooter facts execute",
      "tests/agent/voc-positioning-execution-service.test.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    },
  );

  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /full scooter facts execute/);
  assert.match(executed.stdout, /pass 1/);
});

test("ordinary Node imports the production VOC composition root", () => {
  const executed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      "const runtime = await import('./server/runtime/voc-positioning-runtime.ts'); if (typeof runtime.createVocPositioningRuntime !== 'function') process.exit(2);",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`);
});
