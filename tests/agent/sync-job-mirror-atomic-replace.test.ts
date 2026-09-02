import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const fixture = path.resolve("tests/fixtures/mutate-sync-job-mirror.mjs");
const injector = path.resolve("tests/fixtures/inject-mirror-rename-failure.mjs");
const windowsOnly = { skip: process.platform !== "win32" };

type FixtureResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly output: {
    readonly ok: boolean;
    readonly attempts: number;
    readonly waits: readonly number[];
    readonly code?: string | null;
    readonly lockRecovered?: boolean | null;
    readonly result?: unknown;
  };
};

test("two mirror writer processes merge fields after two transient Windows EPERM replacements", windowsOnly, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-mirror-transient-"));
  const target = path.join(directory, "job-transient.json");
  try {
    await writeFile(target, JSON.stringify({ jobId: "job-transient", payload: "x".repeat(640_000) }));
    const [worker, runner] = await Promise.all([
      runFixture("async", target, "workerAck", 14, { code: "EPERM", count: 2 }),
      runFixture("sync", target, "runnerProgress", 26),
    ]);

    assert.equal(worker.code, 0, worker.stderr);
    assert.equal(runner.code, 0, runner.stderr);
    assert.equal(worker.output.attempts, 3);
    assert.deepEqual(worker.output.waits, [10, 20]);
    assert.equal(runner.output.attempts, 0);
    const final = JSON.parse(await readFile(target, "utf8"));
    assert.equal(final.workerAck, 14);
    assert.equal(final.runnerProgress, 26);
    assert.equal(await temporaryCount(directory), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent Windows EPERM exhausts six attempts, preserves the destination, cleans temp, and releases the lock", windowsOnly, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-mirror-persistent-"));
  const target = path.join(directory, "job-persistent.json");
  const original = JSON.stringify({ jobId: "job-persistent", published: true });
  try {
    await writeFile(target, original);
    const failed = await runFixture("async", target, "mustNotPublish", true, {
      code: "EPERM", count: 6, recoverLock: true,
    });

    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(failed.output.code, "EPERM");
    assert.equal(failed.output.attempts, 6);
    assert.deepEqual(failed.output.waits, [10, 20, 40, 80, 160]);
    assert.equal(failed.output.lockRecovered, true);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(await temporaryCount(directory), 0);

    const recovered = await runFixture("sync", target, "lockRecovered", true);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(await readFile(target, "utf8")).lockRecovered, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent Windows EPERM replaces a scoped diagnostic mirror in place after retries", windowsOnly, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-mirror-scoped-persistent-"));
  const target = path.join(directory, "job-scoped-persistent.json");
  const scope = { organizationId: "organization-1", projectId: "project-1", runId: "run-1" };
  const original = { jobId: "job-scoped-persistent", scope, message: "before" };
  const next = { ...original, message: "after" };
  try {
    await writeFile(target, JSON.stringify(original));
    const applied = await runFixture("async", target, "message", "after", {
      code: "EPERM", count: 6,
    });

    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(applied.output.attempts, 6);
    assert.deepEqual(applied.output.waits, [10, 20, 40, 80, 160]);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), next);
    assert.equal(await temporaryCount(directory), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mirror compare-and-swap retries one transient Windows EPERM and applies the exact digest", windowsOnly, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-mirror-cas-"));
  const target = path.join(directory, "job-cas.json");
  try {
    await writeFile(target, JSON.stringify({ jobId: "job-cas", jobVersion: 13 }));
    const applied = await runFixture("cas", target, "jobVersion", 14, { code: "EPERM", count: 1 });

    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(applied.output.attempts, 2);
    assert.deepEqual(applied.output.waits, [10]);
    assert.equal(applied.output.result, "applied");
    assert.equal(JSON.parse(await readFile(target, "utf8")).jobVersion, 14);
    assert.equal(await temporaryCount(directory), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const code of ["EACCES", "EBUSY"] as const) {
  test(`Windows mirror replacement treats ${code} as transient`, windowsOnly, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `sync-mirror-${code.toLowerCase()}-`));
    const target = path.join(directory, `job-${code.toLowerCase()}.json`);
    try {
      await writeFile(target, JSON.stringify({ jobId: `job-${code.toLowerCase()}` }));
      const applied = await runFixture("async", target, "published", true, { code, count: 1 });

      assert.equal(applied.code, 0, applied.stderr);
      assert.equal(applied.output.attempts, 2);
      assert.deepEqual(applied.output.waits, [10]);
      assert.equal(JSON.parse(await readFile(target, "utf8")).published, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("non-transient mirror EIO fails closed after one rename attempt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-mirror-eio-"));
  const target = path.join(directory, "job-eio.json");
  const original = JSON.stringify({ jobId: "job-eio", published: true });
  try {
    await writeFile(target, original);
    const failed = await runFixture("sync", target, "mustNotPublish", true, { code: "EIO", count: 6 });

    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(failed.output.code, "EIO");
    assert.equal(failed.output.attempts, 1);
    assert.deepEqual(failed.output.waits, []);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(await temporaryCount(directory), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runFixture(
  mode: "async" | "sync" | "cas",
  target: string,
  field: string,
  value: unknown,
  failure?: { readonly code: string; readonly count: number; readonly recoverLock?: boolean },
): Promise<FixtureResult> {
  const args = [
    ...(failure ? ["--import", pathToFileURL(injector).href] : []),
    fixture,
    mode,
    target,
    field,
    JSON.stringify(value),
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(failure ? {
        TEST_MIRROR_RENAME_TARGET: target,
        TEST_MIRROR_RENAME_FAILURE_CODE: failure.code,
        TEST_MIRROR_RENAME_FAILURE_COUNT: String(failure.count),
        TEST_MIRROR_CAPTURE_RENAME_WAITS: "1",
        ...(failure.recoverLock ? { TEST_MIRROR_RECOVER_LOCK: "1" } : {}),
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error(`mirror fixture produced no output: ${stderr}`);
  return { code, signal, stderr, output: JSON.parse(line) };
}

async function temporaryCount(directory: string): Promise<number> {
  return (await readdir(directory)).filter((name) => name.includes(".tmp-")).length;
}
