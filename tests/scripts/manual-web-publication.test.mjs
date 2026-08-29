import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  manualWebPublicationDescriptor,
  publishManualWebUpdate,
} from "../../scripts/lib/manual-web-publication.mjs";

test("manual publication identity binds generation and exact snapshot hash", () => {
  const artifactId = "a".repeat(64);
  const hash = createHash("sha256").update("exact-voc-source").digest("hex");
  const descriptor = manualWebPublicationDescriptor({ artifactId, generation: 7, sourceHash: hash });
  assert.match(descriptor.jobId, /^manual-alexa-voc-g7-/);
  assert.equal(descriptor.jobVersion, 7);
  assert.deepEqual(descriptor.stageContentHashes, { alexa_voc: hash });
});

test("manual publication rejects a projection or snapshot that differs from the claimed build input", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-snapshot-mismatch-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    const snapshotPath = path.join(worktree, "snapshot.ts");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "projection", "utf8");
    await fs.writeFile(snapshotPath, "snapshot", "utf8");
    await assert.rejects(publishManualWebUpdate({
      worktree,
      resolveWorktree: () => worktree,
      env: { WEB_PORT: "31900" },
      generation: 1,
      sourceHash: createHash("sha256").update("snapshot").digest("hex"),
      snapshotPath,
      build: async () => assert.fail("mismatched input must not build"),
    }), /snapshot mismatch/);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("real artifact and reload modules publish the exact generation snapshot to formal 31900", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-integration-"));
  try {
    const source = "export const rufusVocData = { generation: 9 };";
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    const projection = path.join(worktree, "app", "rufus-voc-data.ts");
    const snapshotPath = path.join(worktree, "generation-9.ts");
    await fs.writeFile(projection, source, "utf8");
    await fs.writeFile(snapshotPath, source, "utf8");
    const artifactId = "d".repeat(64);
    const hash = createHash("sha256").update(source).digest("hex");
    const result = await publishManualWebUpdate({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree, WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
      generation: 9,
      sourceHash: hash,
      snapshotPath,
      createArtifactId: () => artifactId,
      build: async () => {
        await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
        await fs.writeFile(path.join(worktree, "dist", "index.html"), "lightweight-build", "utf8");
        await fs.writeFile(path.join(worktree, "dist", "voc-source.txt"), await fs.readFile(projection, "utf8"), "utf8");
      },
    });
    const candidate = path.join(worktree, "data", "web-runtime-artifacts", `publication-${artifactId}`);
    const manifest = JSON.parse(await fs.readFile(path.join(candidate, "web-artifact.json"), "utf8"));
    const pendingDir = path.join(worktree, "data", "web-reload-requests", "pending");
    const pendingNames = await fs.readdir(pendingDir);
    assert.equal(pendingNames.length, 1);
    const pending = JSON.parse(await fs.readFile(path.join(pendingDir, pendingNames[0]), "utf8"));
    const expectedWorktreeId = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    assert.equal(await fs.readFile(path.join(candidate, "voc-source.txt"), "utf8"), source);
    assert.equal(manifest.jobVersion, 9);
    assert.equal(manifest.stageContentHashes.alexa_voc, hash);
    assert.equal(pending.jobVersion, 9);
    assert.equal(pending.stageContentHashes.alexa_voc, hash);
    assert.deepEqual(pending.target, { worktreeId: expectedWorktreeId, webHost: "0.0.0.0", webPort: 31900 });
    assert.equal(result.sourceHash, hash);
    assert.equal(result.generation, 9);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});
