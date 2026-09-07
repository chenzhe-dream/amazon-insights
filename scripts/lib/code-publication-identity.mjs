// Shared wire identity only: no filesystem or publication dependencies.
export function validateCodeRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "baseArtifactId,sourceCommit,sourceHash"
    || typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceCommit)
    || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || typeof value.baseArtifactId !== "string" || !/^[a-f0-9]{64}$/.test(value.baseArtifactId)) {
    throw new Error("Invalid code release identity");
  }
  return Object.freeze({ sourceCommit: value.sourceCommit, sourceHash: value.sourceHash, baseArtifactId: value.baseArtifactId });
}

export function codeReleasesMatch(left, right) {
  try { return JSON.stringify(validateCodeRelease(left)) === JSON.stringify(validateCodeRelease(right)); }
  catch { return false; }
}

export function assertCodeOnly(value) {
  if (value.kind !== "code" || ["jobId", "jobVersion", "stageContentHashes", "stream", "generation"].some((key) => value[key] !== undefined)) {
    throw new Error("Invalid code publication fields");
  }
  return validateCodeRelease(value.codeRelease);
}

export function boundedCodeSource(sourceCommit, sourceHash) {
  if (typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit)
    || typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) return undefined;
  return Object.freeze({ sourceCommit, sourceHash });
}

export function boundedWebCodeRelease(env) {
  try {
    return validateCodeRelease({ sourceCommit: env.WEB_CODE_SOURCE_COMMIT, sourceHash: env.WEB_CODE_SOURCE_HASH, baseArtifactId: env.WEB_CODE_BASE_ARTIFACT_ID });
  } catch { return undefined; }
}
