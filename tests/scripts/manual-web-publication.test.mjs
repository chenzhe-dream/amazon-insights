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

test("manual publication identity binds the exact Alexa projection", () => {
  const artifactId = "a".repeat(64);
  const descriptor = manualWebPublicationDescriptor({ artifactId, source: "exact-voc-source" });

  assert.equal(descriptor.jobId, `manual-alexa-voc-${artifactId.slice(0, 32)}`);
  assert.equal(descriptor.jobVersion, 1);
  assert.deepEqual(descriptor.stageContentHashes, {
    alexa_voc: createHash("sha256").update("exact-voc-source").digest("hex"),
  });
});

test("manual publication writes reload only after immutable artifact succeeds", async () => {
  const calls = [];

  const result = await publishManualWebUpdate({
    worktree: "C:/safe-worktree",
    env: { WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
    build: async () => { calls.push("build"); },
    readSource: async () => "voc-source",
    createArtifactId: () => "b".repeat(64),
    resolveWorktree: () => "C:/safe-worktree",
    publishArtifact: async (input) => {
      calls.push("artifact");
      await input.build();
      return { id: input.artifactId };
    },
    writeReloadRequest: async (input) => {
      calls.push("reload");
      return { id: "c".repeat(64), payload: input };
    },
  });

  assert.deepEqual(calls, ["artifact", "build", "reload"]);
  assert.equal(result.artifactId, "b".repeat(64));
  assert.equal(result.reloadRequestId, "c".repeat(64));
});

test("a source rewrite during build retries until the newest stable source hash matches the artifact", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-stable-"));
  try {
    const sourceFile = path.join(worktree, "app", "rufus-voc-data.ts");
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, "voc-generation-a", "utf8");
    let builds = 0;
    const artifacts = [];
    const reloads = [];
    const ids = ["a".repeat(64), "b".repeat(64)];
    const result = await publishManualWebUpdate({
      worktree,
      env: { WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
      createArtifactId: () => ids.shift(),
      resolveWorktree: () => worktree,
      build: async () => {
        builds += 1;
        if (builds === 1) await fs.writeFile(sourceFile, "voc-generation-b", "utf8");
      },
      publishArtifact: async (input) => {
        artifacts.push(input);
        await input.build();
        return { id: input.artifactId };
      },
      writeReloadRequest: async (input) => {
        reloads.push(input);
        return { id: "c".repeat(64), payload: input };
      },
    });
    const expected = createHash("sha256").update("voc-generation-b").digest("hex");
    assert.equal(builds, 2);
    assert.equal(artifacts.length, 2);
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0].stageContentHashes.alexa_voc, expected);
    assert.equal(artifacts[1].stageContentHashes.alexa_voc, expected);
    assert.equal(result.sourceHash, expected);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("real artifact and reload modules publish a formal 31900 candidate from a lightweight build", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-integration-"));
  try {
    const source = "export const rufusVocData = { latest: true };";
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), source, "utf8");
    const artifactId = "d".repeat(64);
    const result = await publishManualWebUpdate({
      worktree,
      env: {
        AGENT_FORMAL_WORKTREE_ROOT: worktree,
        WEB_HOST: "0.0.0.0",
        WEB_PORT: "31900",
      },
      createArtifactId: () => artifactId,
      build: async () => {
        await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
        await fs.writeFile(path.join(worktree, "dist", "index.html"), "lightweight-build", "utf8");
        await fs.writeFile(
          path.join(worktree, "dist", "voc-source.txt"),
          await fs.readFile(path.join(worktree, "app", "rufus-voc-data.ts"), "utf8"),
          "utf8",
        );
      },
    });
    const candidate = path.join(worktree, "data", "web-runtime-artifacts", `publication-${artifactId}`);
    const manifest = JSON.parse(await fs.readFile(path.join(candidate, "web-artifact.json"), "utf8"));
    const pendingDir = path.join(worktree, "data", "web-reload-requests", "pending");
    const pendingNames = await fs.readdir(pendingDir);
    assert.equal(pendingNames.length, 1);
    const pending = JSON.parse(await fs.readFile(path.join(pendingDir, pendingNames[0]), "utf8"));
    const expectedHash = createHash("sha256").update(source).digest("hex");
    const expectedWorktreeId = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    assert.equal(await fs.readFile(path.join(candidate, "voc-source.txt"), "utf8"), source);
    assert.equal(manifest.stageContentHashes.alexa_voc, expectedHash);
    assert.equal(pending.stageContentHashes.alexa_voc, expectedHash);
    assert.equal(pending.artifactId, artifactId);
    assert.deepEqual(pending.target, { worktreeId: expectedWorktreeId, webHost: "0.0.0.0", webPort: 31900 });
    assert.equal(result.sourceHash, expectedHash);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});
