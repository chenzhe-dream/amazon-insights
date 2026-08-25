import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWebArtifactStore,
  createWebPublicationArtifactId,
  writeCurrentWebArtifact,
} from "../../scripts/lib/web-artifact-store.mjs";

const jobId = "job-safe-123";
const jobVersion = 9;
const stageContentHashes = Object.freeze({
  category: "b".repeat(64),
  keywords: "c".repeat(64),
});

async function withArtifactRoot(run) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "web-artifact-store-"));
  const artifactRoot = path.join(worktree, "dist");
  try {
    await run({ worktree, artifactRoot });
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
}

test("a build artifact identity is bounded and recovered from the dist manifest", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const artifactId = createWebPublicationArtifactId();
    assert.match(artifactId, /^[a-f0-9]{64}$/);

    await writeCurrentWebArtifact({ worktree, artifactId, jobId, jobVersion, stageContentHashes });

    assert.deepEqual(createWebArtifactStore({ worktree, artifactRoot }).current(), {
      id: artifactId,
      root: artifactRoot,
      jobId,
      jobVersion,
      stageContentHashes,
    });
  });
});

test("successive manifest replacements remain atomic on Windows filesystems", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);

    await writeCurrentWebArtifact({ worktree, artifactId: first, jobId, jobVersion, stageContentHashes });
    await writeCurrentWebArtifact({ worktree, artifactId: second, jobId, jobVersion, stageContentHashes });

    assert.deepEqual(createWebArtifactStore({ worktree, artifactRoot }).current(), {
      id: second,
      root: artifactRoot,
      jobId,
      jobVersion,
      stageContentHashes,
    });
    assert.deepEqual(await readdir(artifactRoot), ["web-artifact.json"]);
  });
});

test("snapshots preserve their path identity and supplied publication identity", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    await writeFile(path.join(worktree, "source.txt"), "artifact source");
    await writeCurrentWebArtifact({ worktree, artifactId: "c".repeat(64), jobId, jobVersion, stageContentHashes });
    await writeFile(path.join(artifactRoot, "index.html"), "artifact");

    const snapshot = await createWebArtifactStore({ worktree }).snapshot({
      id: "c".repeat(64),
      root: artifactRoot,
      publicationArtifactId: "d".repeat(64),
      jobId,
      jobVersion,
      stageContentHashes,
    });

    assert.match(snapshot.id, /^snapshot-\d+-[a-f0-9-]+$/);
    assert.equal(snapshot.publicationArtifactId, "d".repeat(64));
    assert.equal(snapshot.jobId, jobId);
    assert.equal(snapshot.jobVersion, jobVersion);
    assert.deepEqual(snapshot.stageContentHashes, stageContentHashes);
  });
});

test("malformed, unknown, or out-of-worktree artifact manifests fail closed", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const manifest = path.join(artifactRoot, "web-artifact.json");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(manifest, JSON.stringify({ artifactId: "wrong" }));
    assert.throws(() => createWebArtifactStore({ worktree, artifactRoot }).current(), /Invalid Web artifact manifest/);

    await writeFile(manifest, JSON.stringify({ version: 1, artifactId: "a".repeat(64), root: "C:/outside" }));
    assert.throws(() => createWebArtifactStore({ worktree, artifactRoot }).current(), /Invalid Web artifact manifest/);
  });
});

test("artifact writer rejects a dist junction that resolves outside its worktree", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "web-artifact-external-"));
    try {
      await symlink(externalRoot, artifactRoot, "junction");
      await assert.rejects(
        writeCurrentWebArtifact({ worktree, artifactId: "e".repeat(64), jobId, jobVersion, stageContentHashes }),
        /Invalid Web artifact path/,
      );
      await assert.rejects(
        writeFile(path.join(externalRoot, "web-artifact.json"), "", { flag: "r" }),
        /ENOENT/,
      );
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
