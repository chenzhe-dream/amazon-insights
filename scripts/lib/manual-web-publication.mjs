import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveFormalWorktreeRoot } from "./formal-worktree-root.mjs";

import {
  createWebPublicationArtifactId,
  publishImmutableWebArtifact,
} from "./web-artifact-store.mjs";
import {
  configuredWebReloadTarget,
  writeWebReloadRequest,
} from "./web-reload-request.mjs";

export function manualWebPublicationDescriptor({ artifactId, source }) {
  if (!/^[a-f0-9]{64}$/.test(artifactId) || typeof source !== "string") {
    throw new Error("Invalid manual Web publication");
  }
  return Object.freeze({
    jobId: `manual-alexa-voc-${artifactId.slice(0, 32)}`,
    jobVersion: 1,
    stageContentHashes: Object.freeze({
      alexa_voc: createHash("sha256").update(source).digest("hex"),
    }),
  });
}

export async function publishManualWebUpdate(options) {
  const worktree = (options.resolveWorktree ?? (() => resolveFormalWorktreeRoot({
    env: options.env,
    cwd: options.cwd,
    worktree: options.worktree,
  })))();
  const readSource = options.readSource ?? (() => fs.readFile(
    path.join(worktree, "app", "rufus-voc-data.ts"),
    "utf8",
  ));
  const maxStabilityAttempts = options.maxStabilityAttempts ?? 3;
  if (!Number.isSafeInteger(maxStabilityAttempts) || maxStabilityAttempts < 1 || maxStabilityAttempts > 10) {
    throw new Error("Invalid manual Web publication stability limit");
  }
  for (let attempt = 0; attempt < maxStabilityAttempts; attempt += 1) {
    const source = await readSource();
    const artifactId = (options.createArtifactId ?? createWebPublicationArtifactId)();
    const descriptor = manualWebPublicationDescriptor({ artifactId, source });
    await (options.publishArtifact ?? publishImmutableWebArtifact)({
      worktree,
      artifactId,
      ...descriptor,
      build: options.build,
    });
    const sourceAfterBuild = await readSource();
    if (sourceAfterBuild !== source) continue;
    const written = await (options.writeReloadRequest ?? writeWebReloadRequest)({
      ...descriptor,
      artifactId,
      buildCompletedAt: new Date().toISOString(),
      target: configuredWebReloadTarget(options.env, worktree),
    }, {
      spoolDir: path.join(worktree, "data", "web-reload-requests"),
    });
    return Object.freeze({
      artifactId,
      reloadRequestId: written.id,
      sourceHash: descriptor.stageContentHashes.alexa_voc,
    });
  }
  throw new Error("Alexa VOC source did not stabilize during publication");
}
