import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";
import {
  cleanupExpiredImageRemarkCandidates,
  ImageRemarkCandidateRetentionService,
} from "../../server/services/image-remark-candidate-retention-service";

const DAY_MS = 24 * 60 * 60 * 1000;

async function candidate(root: string, name: string, ageMs: number, files = ["listing.json", "image-candidate.json"]) {
  const directory = path.join(root, "sync-image-candidates", name);
  await mkdir(directory, { recursive: true });
  const when = new Date(Date.now() - ageMs);
  for (const file of files) {
    const target = path.join(directory, file);
    await writeFile(target, JSON.stringify({ id: randomUUID() }));
    await utimes(target, when, when);
  }
  await utimes(directory, when, when);
  return directory;
}

test("cleanup deletes only expired known candidate directories and preserves newer writes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expired = await candidate(root, "image-ABC123", DAY_MS + 60_000);
  const recent = await candidate(root, "image-DEF456", DAY_MS - 60_000);
  const recentlyWritten = await candidate(root, "image-GHI789", DAY_MS + 60_000);
  await utimes(path.join(recentlyWritten, "image-candidate.json"), new Date(), new Date());
  const unknownContent = await candidate(root, "image-JKL012", DAY_MS + 60_000, ["listing.json", "other-report.json"]);
  const unrelated = await candidate(root, "other-ABC123", DAY_MS + 60_000);
  const rootDirectory = path.join(root, "sync-image-candidates");
  await writeFile(path.join(rootDirectory, "image-MNO345"), "not a directory");

  const result = await cleanupExpiredImageRemarkCandidates({ dataRoot: root });
  assert.equal(result.purgedCount, 1);
  assert.equal(existsSync(expired), false);
  for (const preserved of [recent, recentlyWritten, unknownContent, unrelated]) {
    assert.equal(existsSync(preserved), true);
  }
  assert.equal(existsSync(path.join(rootDirectory, "image-MNO345")), true);
});

test("cleanup never deletes a candidate whose runner PID is live", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-retention-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const live = await candidate(root, `image-${process.pid}-ABC123`, DAY_MS + 60_000);
  const dead = await candidate(root, "image-XYZ987", DAY_MS + 60_000);
  const result = await cleanupExpiredImageRemarkCandidates({ dataRoot: root });
  assert.equal(result.purgedCount, 1);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(dead), false);
});

test("cleanup refuses a candidate path that is a directory symlink", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-retention-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = path.join(root, "external-report");
  await mkdir(external);
  const marker = path.join(external, "marker.json");
  await writeFile(marker, "keep");
  const candidateRoot = path.join(root, "sync-image-candidates");
  await mkdir(candidateRoot);
  try {
    await symlink(external, path.join(candidateRoot, "image-SYM123"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Directory symlinks require extra permission on this host");
      return;
    }
    throw error;
  }
  const result = await cleanupExpiredImageRemarkCandidates({
    dataRoot: root,
    now: new Date(Date.now() + DAY_MS + 60_000),
  });
  assert.equal(result.purgedCount, 0);
  assert.equal(existsSync(marker), true);
});

test("retention sweeps immediately and periodically without overlapping", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const service = new ImageRemarkCandidateRetentionService({
    dataRoot: path.join(tmpdir(), "unused-image-retention-root"),
    intervalMs: 10,
    cleanup: async () => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      if (calls === 1) await gate;
      active -= 1;
      return { purgedCount: 0 };
    },
  });
  try {
    service.start();
    service.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 1);
    release();
    const deadline = Date.now() + 1000;
    while (calls < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls >= 2);
    await service.stop();
    assert.equal(maximum, 1);
    const stoppedAt = calls;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, stoppedAt);
  } finally {
    release();
    await service.stop();
  }
});

test("Agent Service startup sweeps an expired candidate under its configured data root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-retention-agent-"));
  const expired = await candidate(root, "image-ABC123", DAY_MS + 60_000);
  const repository = await openRuntimeAgentRepository({
    kind: "sqlite",
    sqlite: { path: path.join(root, "agent.sqlite"), busyTimeoutMs: 5_000 },
  });
  const agent = await createAgentService({
    repository,
    logger: false,
    env: {
      NODE_ENV: "test",
      AGENT_DATA_ROOT: root,
      AGENT_SERVICE_PROXY_TOKEN: "image-retention-test-token",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
    },
  });
  t.after(async () => {
    await agent.stop();
    repository.close();
    await rm(root, { recursive: true, force: true });
  });
  await agent.start({ host: "127.0.0.1", port: 0 });
  const deadline = Date.now() + 2_000;
  while (existsSync(expired) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(expired), false);
});
