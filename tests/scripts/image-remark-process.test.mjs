import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseImageRemarkProgress,
  runImageRemarkProcess,
} from "../../scripts/lib/image-remark-process.mjs";

test("image remark progress accepts only the exact safe protocol", () => {
  assert.deepEqual(
    parseImageRemarkProgress('IMAGE_REMARK_PROGRESS {"completed":3,"total":20,"status":"ready"}'),
    { completed: 3, total: 20, status: "ready" },
  );
  assert.equal(
    parseImageRemarkProgress('IMAGE_REMARK_PROGRESS {"completed":3,"total":20,"status":"ready","url":"secret"}'),
    null,
  );

  for (const invalid of [
    "not progress",
    "IMAGE_REMARK_PROGRESS nope",
    'IMAGE_REMARK_PROGRESS {"completed":-1,"total":20,"status":"ready"}',
    'IMAGE_REMARK_PROGRESS {"completed":21,"total":20,"status":"ready"}',
    'IMAGE_REMARK_PROGRESS {"completed":1.5,"total":20,"status":"ready"}',
    'IMAGE_REMARK_PROGRESS {"completed":1,"total":20,"status":"unknown"}',
  ]) {
    assert.equal(parseImageRemarkProgress(invalid), null, invalid);
  }
});

test("image remark process launches once, streams progress, and never retries", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "image-remark-process-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureRoot, "fixture.mjs");
  await writeFile(fixturePath, [
    'process.stdout.write(\'IMAGE_REMARK_PROGRESS {"completed":1,"total":2,"status":"ready"}\\n\');',
    'process.stdout.write(\'diagnostic without a URL\\n\');',
    'process.stdout.write(\'IMAGE_REMARK_PROGRESS {"completed":2,"total":2,"status":"connector-failed"}\\n\');',
    'process.stderr.write(\'safe stderr\\n\');',
  ].join("\n"), "utf8");

  const progress = [];
  const output = [];
  let spawnCount = 0;
  const result = await runImageRemarkProcess({
    command: process.execPath,
    args: [fixturePath],
    cwd: fixtureRoot,
    env: {},
    spawnProcess: (...args) => {
      spawnCount += 1;
      return spawn(...args);
    },
    onProgress: event => progress.push(event),
    onOutput: text => output.push(text),
  });

  assert.equal(result.succeeded, true);
  assert.deepEqual(result, { succeeded: true, exitCode: 0 });
  assert.deepEqual(progress.map(item => item.completed), [1, 2]);
  assert.equal(spawnCount, 1);
  assert.match(output.join(""), /diagnostic without a URL\n/);
  assert.match(output.join(""), /safe stderr\n/);
});

test("image remark process reports one failed exit without a fallback launch", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "image-remark-process-failure-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureRoot, "fixture.mjs");
  await writeFile(fixturePath, "process.exitCode = 7;\n", "utf8");

  let spawnCount = 0;
  const result = await runImageRemarkProcess({
    command: process.execPath,
    args: [fixturePath],
    cwd: fixtureRoot,
    env: {},
    spawnProcess: (...args) => {
      spawnCount += 1;
      return spawn(...args);
    },
  });

  assert.deepEqual(result, { succeeded: false, exitCode: 7 });
  assert.equal(spawnCount, 1);
});

test("image remark process rejects callback integrity errors for the lifecycle owner", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "image-remark-process-callback-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureRoot, "fixture.mjs");
  await writeFile(
    fixturePath,
    'console.log(\'IMAGE_REMARK_PROGRESS {"completed":1,"total":1,"status":"ready"}\');\nsetTimeout(() => {}, 1000);\n',
    "utf8",
  );

  await assert.rejects(
    runImageRemarkProcess({
      command: process.execPath,
      args: [fixturePath],
      cwd: fixtureRoot,
      env: {},
      onProgress: () => {
        throw new Error("sync job store unavailable");
      },
    }),
    /sync job store unavailable/,
  );
});
