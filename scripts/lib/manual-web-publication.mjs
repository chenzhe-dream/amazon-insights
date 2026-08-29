import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  const artifactId = (options.createArtifactId ?? createWebPublicationArtifactId)();
  const source = await (options.readSource ?? (() => fs.readFile(
    path.join(options.worktree, "app", "rufus-voc-data.ts"),
    "utf8",
  )))();
  const descriptor = manualWebPublicationDescriptor({ artifactId, source });

  await (options.publishArtifact ?? publishImmutableWebArtifact)({
    worktree: options.worktree,
    artifactId,
    ...descriptor,
    build: options.build,
  });
  const written = await (options.writeReloadRequest ?? writeWebReloadRequest)({
    ...descriptor,
    artifactId,
    buildCompletedAt: new Date().toISOString(),
    target: configuredWebReloadTarget(options.env, options.worktree),
  });
  return Object.freeze({ artifactId, reloadRequestId: written.id });
}
