import {
  LocalDataStageOutputResponseSchema,
  ProjectableSyncStageSchema,
  type ProjectableSyncStage,
  type StageOutputProjection,
} from "../../shared/agent-contracts";

export type StageOutputScope = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  jobId: string;
}>;

export type StageOutputMissing = Readonly<{
  stage: ProjectableSyncStage;
  stageStatus: "missing-output";
  reasonCode: "OUTPUT_UNAVAILABLE";
}>;

export type StageOutputEntry = StageOutputProjection | StageOutputMissing;
export type StageOutputSnapshot = Readonly<Partial<Record<ProjectableSyncStage, StageOutputEntry>>>;

export type StageOutputOutcome =
  | Readonly<{ kind: "applied"; snapshot: StageOutputSnapshot }>
  | Readonly<{ kind: "resolved-unchanged" }>
  | Readonly<{ kind: "retryable-missing"; attempt: number; remainingAttempts: number }>
  | Readonly<{ kind: "missing-output"; attempt: 3; snapshot: StageOutputSnapshot }>;

type ObservableJob = Readonly<{
  jobId: string;
  jobVersion?: number;
  stages: readonly Readonly<{ id: string; status: string }>[];
}>;

const terminalStatuses = new Set(["done", "partial", "failed"]);

export function createStageOutputOwner(scope: StageOutputScope): {
  observeJob(job: ObservableJob): ProjectableSyncStage[];
  accept(stage: ProjectableSyncStage, candidate: unknown): StageOutputOutcome;
  missing(stage: ProjectableSyncStage): StageOutputOutcome;
  restartTerminalEpisode(resumedStages: readonly string[]): StageOutputSnapshot;
  outputsSettled(job: ObservableJob): boolean;
  snapshot(): StageOutputSnapshot;
  clear(): void;
} {
  let visible: StageOutputSnapshot = Object.freeze({});
  let observedJobVersion = 0;
  const acceptedVersions = new Map<ProjectableSyncStage, Readonly<{
    jobVersion: number;
    outputVersion: number;
    contentHash: string;
  }>>();
  const attempts = new Map<ProjectableSyncStage, number>();
  const resolvedAtJobVersion = new Map<ProjectableSyncStage, number>();
  const terminalEpisodes = new Set<ProjectableSyncStage>();
  const observedTerminalStatuses = new Map<ProjectableSyncStage, string>();

  const recordMissing = (stage: ProjectableSyncStage): StageOutputOutcome => {
    const attempt = Math.min((attempts.get(stage) ?? 0) + 1, 3);
    attempts.set(stage, attempt);
    if (attempt < 3) {
      return { kind: "retryable-missing", attempt, remainingAttempts: 3 - attempt };
    }
    resolvedAtJobVersion.set(stage, observedJobVersion);
    if (!visible[stage]) {
      visible = Object.freeze({
        ...visible,
        [stage]: Object.freeze({ stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }),
      });
    }
    return { kind: "missing-output", attempt: 3, snapshot: visible };
  };

  const terminalStages = (job: ObservableJob): ProjectableSyncStage[] => job.stages.flatMap((stage) => {
    const parsedStage = ProjectableSyncStageSchema.safeParse(stage.id);
    return parsedStage.success && terminalStatuses.has(stage.status) ? [parsedStage.data] : [];
  });

  return {
    observeJob(job) {
      const jobVersion = job.jobVersion;
      if (job.jobId !== scope.jobId || !Number.isSafeInteger(jobVersion) || Number(jobVersion) < 1) return [];
      observedJobVersion = Math.max(observedJobVersion, Number(jobVersion));
      const stages = job.stages.flatMap(stage => {
        const parsedStage = ProjectableSyncStageSchema.safeParse(stage.id);
        if (!parsedStage.success) return [];
        const projectedStage = parsedStage.data;
        if (!terminalStatuses.has(stage.status)) {
          observedTerminalStatuses.delete(projectedStage);
          if (terminalEpisodes.delete(projectedStage)) {
            attempts.delete(projectedStage);
            resolvedAtJobVersion.delete(projectedStage);
            if (visible[projectedStage]?.stageStatus === "missing-output") {
              const { [projectedStage]: _removed, ...retained } = visible;
              visible = Object.freeze(retained);
            }
          }
          return [];
        }
        observedTerminalStatuses.set(projectedStage, stage.status);
        terminalEpisodes.add(projectedStage);
        if ((attempts.get(projectedStage) ?? 0) >= 3) return [];
        return (resolvedAtJobVersion.get(projectedStage) ?? 0) < Number(jobVersion) ? [projectedStage] : [];
      });
      return [...new Set(stages)];
    },
    accept(stage, candidate) {
      const parsed = LocalDataStageOutputResponseSchema.safeParse(candidate);
      if (!parsed.success) return recordMissing(stage);
      const projection = parsed.data;
      const observedStatus = observedTerminalStatuses.get(stage);
      if (
        projection.stage !== stage ||
        projection.stageStatus !== observedStatus ||
        (projection.stageStatus !== "done" && projection.gap.state !== observedStatus) ||
        projection.projectId !== scope.projectId ||
        projection.runId !== scope.runId ||
        projection.jobId !== scope.jobId ||
        projection.jobVersion > observedJobVersion ||
        projection.contentHash !== stageOutputContentHash(projection)
      ) return recordMissing(stage);

      const previousVersion = acceptedVersions.get(projection.stage);
      if (previousVersion) {
        if (
          projection.outputVersion === previousVersion.outputVersion &&
          projection.contentHash === previousVersion.contentHash
        ) {
          attempts.delete(stage);
          resolvedAtJobVersion.set(stage, observedJobVersion);
          return { kind: "resolved-unchanged" };
        }
        if (projection.outputVersion <= previousVersion.outputVersion) return recordMissing(stage);
      }

      attempts.delete(stage);
      acceptedVersions.set(projection.stage, {
        jobVersion: projection.jobVersion,
        outputVersion: projection.outputVersion,
        contentHash: projection.contentHash,
      });
      resolvedAtJobVersion.set(stage, observedJobVersion);
      const previousVisible = visible[projection.stage];
      if (previousVisible?.stageStatus === "done" && projection.stageStatus !== "done") {
        return { kind: "applied", snapshot: visible };
      }
      visible = Object.freeze({ ...visible, [projection.stage]: Object.freeze(projection) });
      return { kind: "applied", snapshot: visible };
    },
    missing(stage) {
      return recordMissing(stage);
    },
    restartTerminalEpisode(resumedStages) {
      for (const resumedStage of resumedStages) {
        const parsedStage = ProjectableSyncStageSchema.safeParse(resumedStage);
        if (!parsedStage.success) continue;
        const stage = parsedStage.data;
        attempts.delete(stage);
        resolvedAtJobVersion.delete(stage);
        terminalEpisodes.delete(stage);
        if (visible[stage]?.stageStatus === "missing-output") {
          const next: Partial<Record<ProjectableSyncStage, StageOutputEntry>> = { ...visible };
          delete next[stage];
          visible = Object.freeze(next);
        }
      }
      return visible;
    },
    outputsSettled(job) {
      const jobVersion = job.jobVersion;
      if (job.jobId !== scope.jobId || !Number.isSafeInteger(jobVersion) || Number(jobVersion) < 1) return true;
      return terminalStages(job).every(stage => (
        (attempts.get(stage) ?? 0) >= 3 ||
        (resolvedAtJobVersion.get(stage) ?? 0) >= Number(jobVersion)
      ));
    },
    snapshot() {
      return visible;
    },
    clear() {
      acceptedVersions.clear();
      attempts.clear();
      resolvedAtJobVersion.clear();
      terminalEpisodes.clear();
      observedTerminalStatuses.clear();
      observedJobVersion = 0;
      visible = Object.freeze({});
    },
  };
}

function stageOutputContentHash(projection: StageOutputProjection): string {
  const branch = projection.stageStatus === "done"
    ? { stage: projection.stage, data: projection.data }
    : { stage: projection.stage, gap: projection.gap };
  return sha256Hex(JSON.stringify(canonicalize(branch)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalize(record[key])]));
}

function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + choice + constants[index]! + words[index]!) >>> 0;
      const s0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0; state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0; state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0; state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0; state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map(value => value.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

const constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
