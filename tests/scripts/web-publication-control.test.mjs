import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebArtifactStore, writeCurrentWebArtifact } from "../../scripts/lib/web-artifact-store.mjs";
import {
  commitWebPublicationControl,
  readWebPublicationControl,
  webPublicationControlPath,
} from "../../scripts/lib/web-publication-control.mjs";
import { createWebReloadTarget } from "../../scripts/lib/web-reload-request.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const HASH_A = "c".repeat(64);
const HASH_B = "d".repeat(64);

async function fixture(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "web-publication-control-"));
  try {
    await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
    await writeCurrentWebArtifact({
      worktree, artifactId: A, jobId: "initial-a", jobVersion: 1, stageContentHashes: { keywords: HASH_A },
    });
    const candidate = path.join(worktree, "data", "web-runtime-artifacts", `publication-${B}`);
    await fs.mkdir(candidate, { recursive: true });
    await fs.writeFile(path.join(candidate, "index.html"), "candidate B", "utf8");
    await fs.writeFile(path.join(candidate, "web-artifact.json"), JSON.stringify({
      version: 2,
      artifactId: B,
      jobId: `manual-alexa-voc-g2-${B.slice(0, 24)}`,
      jobVersion: 2,
      stageContentHashes: { alexa_voc: HASH_B },
    }), "utf8");
    await run({ worktree, candidate });
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
}

test("one durable commit atomically binds current known-good and Alexa applied generation across restart", async () => {
  await fixture(async ({ worktree, candidate }) => {
    const target = createWebReloadTarget({ worktree, webHost: "127.0.0.1", webPort: 43123 });
    const payload = {
      artifactId: B,
      jobId: `manual-alexa-voc-g2-${B.slice(0, 24)}`,
      jobVersion: 2,
      stageContentHashes: { alexa_voc: HASH_B },
      stream: { id: "alexa_voc", generation: 2, epoch: 4 },
      target,
    };
    await commitWebPublicationControl({
      controlPath: webPublicationControlPath(worktree),
      payload,
      requestId: "e".repeat(64),
      now: () => new Date("2026-08-29T10:00:00.000Z"),
    });

    const control = await readWebPublicationControl({ controlPath: webPublicationControlPath(worktree), expectedTarget: target });
    assert.equal(control.current.artifactId, B);
    assert.equal(control.streams.alexa_voc.generation, 2);
    assert.equal(control.streams.alexa_voc.artifactId, B);
    const restarted = createWebArtifactStore({ worktree }).current(target);
    assert.equal(restarted.id, B);
    assert.equal(restarted.root, candidate);
  });
});

test("a damaged durable current pointer fails closed instead of falling back to mutable dist", async () => {
  await fixture(async ({ worktree }) => {
    const controlPath = webPublicationControlPath(worktree);
    await fs.mkdir(path.dirname(controlPath), { recursive: true });
    await fs.writeFile(controlPath, "{truncated", "utf8");
    const target = createWebReloadTarget({ worktree, webHost: "127.0.0.1", webPort: 43123 });
    assert.throws(() => createWebArtifactStore({ worktree }).current(target), /Invalid durable Web publication current/);
  });
});

test("supervisor bootstrap pins a known-good immutable snapshot before mutable dist can change", async () => {
  await fixture(async ({ worktree }) => {
    const target = createWebReloadTarget({ worktree, webHost: "127.0.0.1", webPort: 43123 });
    const store = createWebArtifactStore({ worktree });
    await fs.writeFile(path.join(worktree, "dist", "index.html"), "known good A", "utf8");
    const snapshot = await store.snapshot(store.current(target));
    await store.bootstrapCurrent(snapshot, target);

    await fs.writeFile(path.join(worktree, "dist", "index.html"), "uncommitted mutable B", "utf8");
    await writeCurrentWebArtifact({
      worktree, artifactId: B, jobId: "uncommitted-b", jobVersion: 2, stageContentHashes: { keywords: HASH_B },
    });

    const restarted = createWebArtifactStore({ worktree }).current(target);
    assert.equal(restarted.root, snapshot.root);
    assert.equal(restarted.id, A);
    assert.equal(await fs.readFile(path.join(restarted.root, "index.html"), "utf8"), "known good A");
  });
});
