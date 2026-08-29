import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveFormalWorktreeRoot } from "./formal-worktree-root.mjs";
import { writeFencedAlexaPublicationReloadSync } from "./alexa-publication-state.mjs";
import {
  createWebPublicationArtifactId,
  publishImmutableWebArtifact,
} from "./web-artifact-store.mjs";
import {
  configuredWebReloadTarget,
  writeWebReloadRequestSync,
} from "./web-reload-request.mjs";

function hashSource(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function manualWebPublicationDescriptor({ artifactId, generation, sourceHash }) {
  if (
    !/^[a-f0-9]{64}$/.test(artifactId)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || !/^[a-f0-9]{64}$/.test(sourceHash)
  ) {
    throw new Error("Invalid manual Web publication");
  }
  return Object.freeze({
    jobId: `manual-alexa-voc-g${generation}-${artifactId.slice(0, 24)}`,
    jobVersion: generation,
    stageContentHashes: Object.freeze({ alexa_voc: sourceHash }),
  });
}

export async function publishManualWebUpdate(options) {
  const worktree = (options.resolveWorktree ?? (() => resolveFormalWorktreeRoot({
    env: options.env,
    cwd: options.cwd,
    worktree: options.worktree,
  })))();
  const projectionPath = path.join(worktree, "app", "rufus-voc-data.ts");
  const [snapshot, projection] = await Promise.all([
    fs.readFile(options.snapshotPath, "utf8"),
    fs.readFile(projectionPath, "utf8"),
  ]);
  if (
    snapshot !== projection
    || hashSource(snapshot) !== options.sourceHash
    || hashSource(projection) !== options.sourceHash
  ) {
    throw new Error("Alexa publication snapshot mismatch");
  }

  const artifactId = (options.createArtifactId ?? createWebPublicationArtifactId)();
  const descriptor = manualWebPublicationDescriptor({
    artifactId,
    generation: options.generation,
    sourceHash: options.sourceHash,
  });
  await (options.publishArtifact ?? publishImmutableWebArtifact)({
    worktree,
    artifactId,
    ...descriptor,
    build: options.build,
  });
  const reloadPayload = {
    ...descriptor,
    artifactId,
    buildCompletedAt: new Date().toISOString(),
    target: configuredWebReloadTarget(options.env, worktree),
  };
  const written = writeFencedAlexaPublicationReloadSync({
    worktree,
    token: options.token,
    epoch: options.epoch,
    generation: options.generation,
    sourceHash: options.sourceHash,
    write: () => (options.writeReloadRequest ?? writeWebReloadRequestSync)(reloadPayload, {
      spoolDir: path.join(worktree, "data", "web-reload-requests"),
    }),
  });
  return Object.freeze({
    artifactId,
    reloadRequestId: written.id,
    sourceHash: options.sourceHash,
    generation: options.generation,
  });
}
