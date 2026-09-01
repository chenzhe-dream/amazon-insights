import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyRuntimeRestore,
  planRuntimeRestore,
  rollbackRuntimeRestore,
} from "../../scripts/lib/runtime-data-restore.mjs";

const IDS = {
  common: "10000000-0000-4000-8000-000000000001",
  duplicateSource: "10000000-0000-4000-8000-000000000002",
  uniqueSource: "10000000-0000-4000-8000-000000000003",
  duplicateDestination: "10000000-0000-4000-8000-000000000004",
};

function project(id, name, asins) {
  return { id, name, marketplace: "US", asins, createdAt: "2026-01-01T00:00:00.000Z" };
}

async function writeProject(dataRoot, value) {
  const projects = path.join(dataRoot, "projects");
  await mkdir(projects, { recursive: true });
  await writeFile(path.join(projects, `${value.id}.json`), JSON.stringify(value, null, 2));
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-restore-"));
  const sourceRoot = path.join(root, "source");
  const destinationRoot = path.join(root, "destination");
  const sharedAsins = ["B000000001", "B000000002", "B000000003"];
  const common = project(IDS.common, "Common", ["B000000010", "B000000011", "B000000012"]);
  await writeProject(sourceRoot, common);
  await writeProject(sourceRoot, project(IDS.duplicateSource, "Duplicate source", sharedAsins));
  await writeProject(sourceRoot, project(IDS.uniqueSource, "Unique source", ["B000000020", "B000000021", "B000000022"]));
  await writeProject(destinationRoot, common);
  await writeProject(destinationRoot, project(IDS.duplicateDestination, "Existing same scope", sharedAsins));
  await mkdir(path.join(sourceRoot, "sync-jobs"), { recursive: true });
  await mkdir(path.join(sourceRoot, "alexa-voc"), { recursive: true });
  await mkdir(path.join(sourceRoot, "locks"), { recursive: true });
  await writeFile(path.join(sourceRoot, "agent.sqlite"), "excluded");
  await writeFile(path.join(sourceRoot, "sync-jobs", "job.json"), "{}");
  await writeFile(path.join(sourceRoot, "alexa-voc", "state.json"), "{}");
  await writeFile(path.join(sourceRoot, "locks", "owner.json"), "{}");
  return { root, sourceRoot, destinationRoot };
}

test("restore planning is missing-ID-only, preserves same-scope IDs, and excludes other data", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      () => planRuntimeRestore({
        sourceRoot: fixture.sourceRoot,
        destinationRoot: fixture.destinationRoot,
        activeCount: 1,
      }),
      /active.*0/i,
    );

    const plan = await planRuntimeRestore({
      sourceRoot: fixture.sourceRoot,
      destinationRoot: fixture.destinationRoot,
      activeCount: 0,
    });
    assert.deepEqual(
      plan.missingProjects.map((entry) => entry.id).sort(),
      [IDS.duplicateSource, IDS.uniqueSource].sort(),
    );
    assert.equal(plan.sourceCount, 3);
    assert.equal(plan.destinationCount, 2);
    assert.equal(plan.commonCount, 1);
    assert.equal(plan.unionCount, 4);
    assert.equal(plan.requiresActiveCount, 0);
    assert.deepEqual(plan.sameScopeDifferentId, [{
      sourceId: IDS.duplicateSource,
      destinationIds: [IDS.duplicateDestination],
      action: "preserve-and-mark-duplicate",
    }]);
    assert.ok(plan.copyPaths.every((entry) => path.basename(path.dirname(entry)) === "projects"));
    assert.equal(plan.copyPaths.some((entry) =>
      /sqlite|sync-jobs|alexa|locks|app/i.test(path.relative(fixture.destinationRoot, entry)),
    ), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("apply backs up project JSON first, verifies hashes, and creates only absent IDs", async () => {
  const fixture = await createFixture();
  try {
    const plan = await planRuntimeRestore({
      sourceRoot: fixture.sourceRoot,
      destinationRoot: fixture.destinationRoot,
      activeCount: 0,
    });
    const backupRoot = path.join(fixture.root, "backup");
    const rollbackManifestPath = path.join(fixture.root, "rollback.json");
    const result = await applyRuntimeRestore({ plan, backupRoot, rollbackManifestPath });

    assert.equal(result.created.length, 2);
    const backup = JSON.parse(await readFile(result.backupManifestPath, "utf8"));
    assert.equal(backup.entries.length, 2);
    assert.ok(backup.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
    const manifest = JSON.parse(await readFile(rollbackManifestPath, "utf8"));
    assert.deepEqual(manifest.created, result.created);

    const duplicate = JSON.parse(await readFile(
      path.join(fixture.destinationRoot, "projects", `${IDS.duplicateSource}.json`),
      "utf8",
    ));
    assert.equal(duplicate.runtimeRestore.status, "duplicate-pending-review");
    assert.deepEqual(duplicate.runtimeRestore.sameScopeProjectIds, [IDS.duplicateDestination]);
    assert.equal(await readFile(path.join(fixture.destinationRoot, "agent.sqlite"), "utf8").catch(() => null), null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exclusive create never overwrites a path that appeared after planning", async () => {
  const fixture = await createFixture();
  try {
    const plan = await planRuntimeRestore({
      sourceRoot: fixture.sourceRoot,
      destinationRoot: fixture.destinationRoot,
      activeCount: 0,
    });
    const racedPath = path.join(fixture.destinationRoot, "projects", `${IDS.uniqueSource}.json`);
    await writeFile(racedPath, "do-not-overwrite", { flag: "wx" });
    await assert.rejects(
      () => applyRuntimeRestore({
        plan,
        backupRoot: path.join(fixture.root, "backup"),
        rollbackManifestPath: path.join(fixture.root, "rollback.json"),
      }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(await readFile(racedPath, "utf8"), "do-not-overwrite");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rollback removes only manifest-listed files whose hashes are unchanged", async () => {
  const fixture = await createFixture();
  try {
    const plan = await planRuntimeRestore({
      sourceRoot: fixture.sourceRoot,
      destinationRoot: fixture.destinationRoot,
      activeCount: 0,
    });
    const rollbackManifestPath = path.join(fixture.root, "rollback.json");
    await applyRuntimeRestore({
      plan,
      backupRoot: path.join(fixture.root, "backup"),
      rollbackManifestPath,
    });
    const changedPath = path.join(fixture.destinationRoot, "projects", `${IDS.uniqueSource}.json`);
    await writeFile(changedPath, "changed-after-restore");

    const result = await rollbackRuntimeRestore({ manifestPath: rollbackManifestPath });
    assert.deepEqual(result.skippedChanged, [changedPath]);
    await assert.rejects(readFile(
      path.join(fixture.destinationRoot, "projects", `${IDS.duplicateSource}.json`),
      "utf8",
    ), { code: "ENOENT" });
    assert.equal(await readFile(changedPath, "utf8"), "changed-after-restore");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run CLI reports derived counts without creating destination projects", async () => {
  const fixture = await createFixture();
  try {
    const cli = path.resolve(import.meta.dirname, "../../scripts/plan-runtime-data-restore.mjs");
    const result = spawnSync(process.execPath, [
      cli,
      "--source", fixture.sourceRoot,
      "--destination", fixture.destinationRoot,
      "--active-count", "0",
      "--dry-run",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      sourceCount: 3,
      destinationCount: 2,
      commonCount: 1,
      unionCount: 4,
      missingCount: 2,
      sameScopeDifferentId: 1,
      conflicts: 0,
      requiresActiveCount: 0,
    });
    await assert.rejects(readFile(
      path.join(fixture.destinationRoot, "projects", `${IDS.uniqueSource}.json`),
      "utf8",
    ), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
