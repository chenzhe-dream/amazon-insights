import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  alexaPublicationTransactionPath,
  commitAlexaVocUpdateSync,
  recoverAlexaPublicationTransactionSync,
} from "../../scripts/lib/alexa-publication-state.mjs";

async function withWorktree(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "alexa-publication-transaction-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "base", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await run(worktree);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
}

function commit(worktree, suffix, fileOps) {
  return commitAlexaVocUpdateSync({
    worktree,
    asin: "B07VY9Q95Q",
    cacheContent: `cache-${suffix}`,
    render: (source) => `${source}-${suffix}`,
    fileOps,
  });
}

test("backup cleanup EPERM occurs after commit and is recovered without rollback", async () => {
  await withWorktree(async (worktree) => {
    commit(worktree, "one");
    let blocked = false;
    const result = commit(worktree, "two", {
      rmSync(target, options) {
        if (!blocked && String(target).includes(".bak-")) {
          blocked = true;
          const error = new Error("backup busy");
          error.code = "EPERM";
          throw error;
        }
        return fsSync.rmSync(target, options);
      },
    });
    assert.equal(result.generation, 2);
    assert.equal(await fs.readFile(path.join(worktree, "app", "rufus-voc-data.ts"), "utf8"), "base-one-two");
    await fs.access(alexaPublicationTransactionPath(worktree));
    recoverAlexaPublicationTransactionSync(worktree);
    await assert.rejects(fs.access(alexaPublicationTransactionPath(worktree)), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(worktree, "app", "rufus-voc-data.ts"), "utf8"), "base-one-two");
  });
});

test("rollback restore failure preserves the only backup and the next recovery restores it", async () => {
  await withWorktree(async (worktree) => {
    commit(worktree, "one");
    const projection = path.join(worktree, "app", "rufus-voc-data.ts");
    let installFailed = false;
    let restoreFailed = false;
    assert.throws(() => commit(worktree, "two", {
      renameSync(source, destination) {
        const from = String(source);
        const to = String(destination);
        if (!installFailed && to === projection && from.includes(".tmp-")) {
          installFailed = true;
          throw new Error("install failed");
        }
        if (!restoreFailed && to === projection && from.includes(".bak-")) {
          restoreFailed = true;
          throw new Error("restore failed");
        }
        return fsSync.renameSync(source, destination);
      },
    }), /recovery pending/);
    const backups = (await fs.readdir(path.dirname(projection))).filter((name) => name.startsWith("rufus-voc-data.ts.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(path.dirname(projection), backups[0]), "utf8"), "base-one");
    await fs.access(alexaPublicationTransactionPath(worktree));
    recoverAlexaPublicationTransactionSync(worktree);
    assert.equal(await fs.readFile(projection, "utf8"), "base-one");
    await assert.rejects(fs.access(alexaPublicationTransactionPath(worktree)), { code: "ENOENT" });
  });
});

test("journal recovery repairs a crash between target-to-backup and temporary-to-target", async () => {
  await withWorktree(async (worktree) => {
    const target = path.join(worktree, "app", "rufus-voc-data.ts");
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const temporary = `${target}.tmp-${transactionId}`;
    const backup = `${target}.bak-${transactionId}`;
    await fs.writeFile(temporary, "new-value", "utf8");
    await fs.rename(target, backup);
    const journal = {
      version: 1,
      transactionId,
      phase: "installing",
      entries: [{ target, temporary, backup, hadOriginal: true }],
    };
    await fs.mkdir(path.dirname(alexaPublicationTransactionPath(worktree)), { recursive: true });
    await fs.writeFile(alexaPublicationTransactionPath(worktree), JSON.stringify(journal), "utf8");
    recoverAlexaPublicationTransactionSync(worktree);
    assert.equal(await fs.readFile(target, "utf8"), "base");
    await assert.rejects(fs.access(temporary), { code: "ENOENT" });
    await assert.rejects(fs.access(backup), { code: "ENOENT" });
    await assert.rejects(fs.access(alexaPublicationTransactionPath(worktree)), { code: "ENOENT" });
  });
});

test("startup recovery removes orphan temporary and backup files without replacing a valid target", async () => {
  await withWorktree(async (worktree) => {
    const target = path.join(worktree, "app", "rufus-voc-data.ts");
    const temporary = `${target}.tmp-22222222-2222-4222-8222-222222222222`;
    const backup = `${target}.bak-33333333-3333-4333-8333-333333333333`;
    const snapshots = path.join(worktree, "data", "alexa-publication-snapshots");
    const corrupt = path.join(snapshots, "generation-9-dead.corrupt-44444444-4444-4444-8444-444444444444");
    await fs.mkdir(snapshots, { recursive: true });
    await fs.writeFile(temporary, "unfinished", "utf8");
    await fs.writeFile(backup, "stale-backup", "utf8");
    await fs.writeFile(corrupt, "corrupt", "utf8");
    recoverAlexaPublicationTransactionSync(worktree);
    assert.equal(await fs.readFile(target, "utf8"), "base");
    await assert.rejects(fs.access(temporary), { code: "ENOENT" });
    await assert.rejects(fs.access(backup), { code: "ENOENT" });
    await assert.rejects(fs.access(corrupt), { code: "ENOENT" });
  });
});

test("a truncated journal is quarantined and fails closed with its backup intact", async () => {
  await withWorktree(async (worktree) => {
    const target = path.join(worktree, "app", "rufus-voc-data.ts");
    const backup = `${target}.bak-55555555-5555-4555-8555-555555555555`;
    await fs.rename(target, backup);
    await fs.mkdir(path.dirname(alexaPublicationTransactionPath(worktree)), { recursive: true });
    await fs.writeFile(alexaPublicationTransactionPath(worktree), '{"version":1', "utf8");
    assert.throws(() => recoverAlexaPublicationTransactionSync(worktree), /recovery pending/);
    await assert.rejects(fs.access(target), { code: "ENOENT" });
    assert.equal(await fs.readFile(backup, "utf8"), "base");
    await assert.rejects(fs.access(alexaPublicationTransactionPath(worktree)), { code: "ENOENT" });
    assert.ok((await fs.readdir(path.join(worktree, "data"))).some((name) => name.startsWith("alexa-publication-transaction.json.corrupt-")));
  });
});

test("a truncated multi-target WAL fails closed without guessing a partial commit", async () => {
  await withWorktree(async (worktree) => {
    const transactionId = "66666666-6666-4666-8666-666666666666";
    const projection = path.join(worktree, "app", "rufus-voc-data.ts");
    const cache = path.join(worktree, "data", "alexa-voc-cache", "B07VY9Q95Q.txt");
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, "old-cache", "utf8");
    const projectionBackup = `${projection}.bak-${transactionId}`;
    const cacheBackup = `${cache}.bak-${transactionId}`;
    await fs.rename(projection, projectionBackup);
    await fs.writeFile(projection, "new-projection", "utf8");
    await fs.rename(cache, cacheBackup);
    await fs.mkdir(path.dirname(alexaPublicationTransactionPath(worktree)), { recursive: true });
    await fs.writeFile(alexaPublicationTransactionPath(worktree), '{"version":1', "utf8");

    assert.throws(() => recoverAlexaPublicationTransactionSync(worktree), /recovery pending/);
    assert.equal(await fs.readFile(projection, "utf8"), "new-projection");
    assert.equal(await fs.readFile(projectionBackup, "utf8"), "base");
    await assert.rejects(fs.access(cache), { code: "ENOENT" });
    assert.equal(await fs.readFile(cacheBackup, "utf8"), "old-cache");
  });
});

test("post-commit fifth-snapshot GC failure is maintenance and does not report the import failed", async () => {
  await withWorktree(async (worktree) => {
    for (let index = 1; index <= 4; index += 1) commit(worktree, `generation-${index}`);
    let blocked = false;
    const fifth = commit(worktree, "generation-5", {
      rmSync(target, options) {
        if (!blocked && String(target).includes("alexa-publication-snapshots") && String(target).endsWith(".ts")) {
          blocked = true;
          const error = new Error("snapshot temporarily busy");
          error.code = "EPERM";
          throw error;
        }
        return fsSync.rmSync(target, options);
      },
    });
    assert.equal(fifth.generation, 5);
    assert.equal(JSON.parse(await fs.readFile(path.join(worktree, "data", "alexa-publication-state.json"), "utf8")).generation, 5);
  });
});
