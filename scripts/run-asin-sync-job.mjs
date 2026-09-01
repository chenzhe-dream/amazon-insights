import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  asinsNeedingMcpSync,
  asinsNeedingCatalogSync,
  asinsNeedingTrafficSync,
  asinsNeedingListingSync,
  estimateAlexaVocSeconds,
  getAsinDataStatus,
  isAsinStageReady,
  readAsinStageReadiness,
  readImageRemarkStatuses,
} from "./lib/asin-data-status.mjs";
import {
  aggregateAsinModuleStatuses,
  commitProjectableStage,
  deriveFinalSyncJobStatus,
  failSyncJob,
  markSyncJobBaseReady,
  markAsinModule,
  mutateSyncJob,
  patchSyncJob,
  reconcileStageStatus,
  readSyncJob,
  setStage,
} from "./lib/sync-job-store.mjs";
import {
  isProjectableSyncStage,
  projectStageOutput,
} from "./lib/sync-stage-output.mjs";
import { loadLocalEnv } from "./lib/local-env.mjs";
import {
  shouldBuildForSync,
  windowsHiddenChildProcessOptions,
} from "./lib/sync-runtime-policy.mjs";
import {
  configuredWebReloadTarget,
  writeWebReloadRequest,
} from "./lib/web-reload-request.mjs";
import {
  createWebPublicationArtifactId,
  publishImmutableWebArtifact,
  writeCurrentWebArtifact,
} from "./lib/web-artifact-store.mjs";
import {
  createProviderDegradationTracker,
  parseProviderDiagnosticOutput,
} from "./lib/provider-diagnostics.mjs";
import { runImageRemarkProcess } from "./lib/image-remark-process.mjs";

const root = path.resolve(import.meta.dirname, "..");

export const BASE_COHORT_STAGE_IDS = [
  "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
  "fba", "listing", "category", "traffic",
];
const TERMINAL_ASIN_STATUSES = new Set(["ready", "upstream-empty", "timeout", "connector-failed", "manual"]);

function formatImageRemarkStageDetail({ completed, total, counts }) {
  return `图片 AI 备注：已完成 ${completed}/${total} 张 · 就绪 ${counts.ready} · 上游无结果 ${counts["upstream-empty"]} · 超时 ${counts.timeout} · 连接失败 ${counts["connector-failed"]}`;
}

export function trafficIsTerminalBeforeImageRemarks(progress) {
  const traffic = progress?.traffic?.status ?? progress?.traffic;
  const imageRemarks = progress?.image_remarks?.status ?? progress?.image_remarks;
  return TERMINAL_ASIN_STATUSES.has(traffic) && imageRemarks === "pending";
}

export function shouldReactivateImageRemarks({
  listingStatus,
  imageRemarkStatus,
  alreadyReactivated,
}) {
  return listingStatus === "ready"
    && imageRemarkStatus === "upstream-empty"
    && alreadyReactivated !== true;
}

export function imageRemarkRunAsins(job, asins) {
  return asins.filter(asin => job?.asinProgress?.[asin]?.image_remarks?.status === "pending");
}

function reactivateImageRemarksForReadyGalleries(jobId, asins) {
  const listingStatusByAsin = new Map(getAsinDataStatus(asins).map(item => [item.asin, item.listing]));
  const reactivated = [];
  mutateSyncJob(jobId, job => {
    const prior = new Set(job.imageRemarkGalleryReactivatedAsins ?? []);
    const asinProgress = { ...job.asinProgress };
    const now = new Date().toISOString();
    for (const asin of asins) {
      const progress = asinProgress[asin];
      if (!shouldReactivateImageRemarks({
        listingStatus: listingStatusByAsin.get(asin),
        imageRemarkStatus: progress?.image_remarks?.status,
        alreadyReactivated: prior.has(asin),
      })) continue;
      prior.add(asin);
      reactivated.push(asin);
      asinProgress[asin] = {
        ...progress,
        image_remarks: {
          status: "pending",
          reason: "GALLERY_BECAME_READY",
          updatedAt: now,
        },
      };
    }
    if (!reactivated.length) return job;
    return {
      ...job,
      asinProgress,
      imageRemarkGalleryReactivatedAsins: [...prior],
      stages: job.stages.map(stage => stage.id === "image_remarks"
        ? {
            ...stage,
            status: "pending",
            detail: "图册已就绪，图片 AI 备注已重新排队。",
            completedAt: null,
          }
        : stage),
    };
  });
  return reactivated;
}

export function shouldRunSyncStage(job, stageId) {
  if (Array.isArray(job?.resumeStages)) return job.resumeStages.includes(stageId);
  const stage = job?.stages?.find(candidate => candidate?.id === stageId);
  return stage?.status !== "partial";
}

export function markPreflightUnavailableStages(jobId, job) {
  const statusByAsin = new Map(getAsinDataStatus(job?.asins ?? []).map(item => [item.asin, item]));
  for (const stage of job?.stages ?? []) {
    if (stage?.status !== "partial" || !BASE_COHORT_STAGE_IDS.includes(stage.id)) continue;
    for (const asin of job?.asins ?? []) {
      const status = statusByAsin.get(asin);
      if (!status || isAsinStageReady(status, stage.id)) continue;
      markAsinModule(jobId, asin, stage.id, {
        status: "connector-failed",
        reason: stage.detail ?? "数据源不可用，本阶段已跳过。",
      });
    }
  }
}

const resumableRepairStatuses = new Set(["connector-failed", "timeout", "pending"]);

export function asinsForSyncStage(job, stageId, readinessCandidates, requestedAsins = readinessCandidates) {
  if (!Array.isArray(job?.resumeStages)) return [...readinessCandidates];
  if (!job.resumeStages.includes(stageId)) return [];
  return requestedAsins.filter((asin) =>
    resumableRepairStatuses.has(job.asinProgress?.[asin]?.[stageId]?.status)
  );
}

const explicitSensitiveEnvironmentKeys = new Set([
  "SELLERSPRITE_SECRET_KEY",
  "SIF_MCP_SECRET",
  "SORFTIME_MCP_KEY",
  "OPENAI_API_KEY",
  "AGENT_SERVICE_PROXY_TOKEN",
  "AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY",
  "AGENT_DATABASE_URL",
  "DATABASE_URL",
]);

function isSensitiveEnvironmentKey(key) {
  const normalized = String(key).toUpperCase();
  return explicitSensitiveEnvironmentKeys.has(normalized)
    || /(?:^|_)(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|AUTH|AUTHORIZATION|COOKIE)(?:_|$)/.test(normalized);
}

export function sanitizeCommandOutput(output, env = process.env) {
  let sanitized = String(output ?? "");
  const sensitiveValues = Object.entries(env)
    .filter(([key, value]) => isSensitiveEnvironmentKey(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);

  for (const value of new Set(sensitiveValues)) {
    sanitized = sanitized.split(value).join("[REDACTED]");
  }

  return sanitized
    .replace(/\b((?:postgres(?:ql)?|https?):\/\/)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(
      /("(?:authorization|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[-_. ]?key|api[-_. ]?key|mcp[-_. ]?key|password|credential|token)"\s*:\s*")[^"\r\n]*(")/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /('(?:authorization|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[-_. ]?key|api[-_. ]?key|mcp[-_. ]?key|password|credential|token)'\s*:\s*')[^'\r\n]*(')/gi,
      "$1[REDACTED]$2",
    )
    .replace(/(\b(?:authorization|cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[-_. ]?key|api[-_. ]?key|mcp[-_. ]?key|password|credential|token)\b\s*[:=]\s*)(?!["'])[^\s,;}\]\r\n]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]");
}

export function formatCommandFailure(label, result, env = process.env) {
  const outcome = result.error
    ? sanitizeCommandOutput(result.error.message, env)
    : result.signal
      ? `signal ${result.signal}`
      : `exit ${result.status}`;
  const safeLabel = sanitizeCommandOutput(label, env).trim().replace(/\s+/g, " ").slice(0, 200);
  const prefix = `${safeLabel} failed (${outcome.slice(0, 500)})`.slice(0, 1_000);
  const diagnostic = sanitizeCommandOutput(result.stderr || result.stdout || "", env)
    .trim()
    .replace(/\s+/g, " ");
  const diagnosticBudget = Math.max(0, 1_000 - prefix.length - 2);
  if (!diagnostic || diagnosticBudget === 0) return prefix;
  return `${prefix}: ${diagnostic.slice(-diagnosticBudget)}`.slice(0, 1_000);
}

function runCommand(label, command, args, env = {}) {
  console.log(`[job] ${label}`);
  const commandEnv = { ...process.env, ...env };
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    ...windowsHiddenChildProcessOptions(),
  });
  if (result.stdout) process.stdout.write(sanitizeCommandOutput(result.stdout, commandEnv));
  if (result.stderr) process.stderr.write(sanitizeCommandOutput(result.stderr, commandEnv));
  const diagnostics = parseProviderDiagnosticOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error || result.status !== 0) {
    const error = new Error(formatCommandFailure(label, result, commandEnv));
    error.diagnostics = diagnostics;
    throw error;
  }
  return { diagnostics };
}

export async function publishWebBuild(
  jobId,
  {
    worktree = root,
    spoolDir = path.join(worktree, "data", "web-reload-requests"),
    env = process.env,
    createArtifactId = createWebPublicationArtifactId,
    build = () => runCommand("build", "npm", ["run", "build"]),
    writeManifest = writeCurrentWebArtifact,
    publishArtifact = publishImmutableWebArtifact,
    completeBuildStage = (currentJobId) => completeStage(currentJobId, "build"),
    now = () => new Date().toISOString(),
    configuredTarget = configuredWebReloadTarget,
    writeReloadRequest = writeWebReloadRequest,
    readJob = readSyncJob,
    patchJob = patchSyncJob,
    projectOutput = projectStageOutput,
    persistenceAttempts = 20,
    waitForPersistence = () => new Promise((resolve) => setTimeout(resolve, 50)),
  } = {},
) {
  const initialJob = readJob(jobId);
  const expectedHashes = projectFinalStageHashes(jobId, initialJob, projectOutput);
  let reconciliation = null;
  for (let attempt = 0; attempt < persistenceAttempts; attempt += 1) {
    const candidate = attempt === 0 ? initialJob : readJob(jobId);
    const candidateHashes = projectFinalStageHashes(jobId, candidate, projectOutput);
    if (!stageHashesMatch(candidateHashes, expectedHashes)) {
      throw publicationContentMismatch("Final persisted stage projection set changed during acknowledgement");
    }
    if (
      Number.isSafeInteger(candidate?.jobVersion) && candidate.jobVersion >= initialJob.jobVersion &&
      stageHashesMatch(candidate?.persistedStageContentHashes, expectedHashes)
    ) {
      reconciliation = Object.freeze({
        jobId,
        jobVersion: candidate.jobVersion,
        stageContentHashes: expectedHashes,
      });
      break;
    }
    if (attempt + 1 < persistenceAttempts) await waitForPersistence();
  }
  if (!reconciliation) {
    throw publicationContentMismatch("Final persisted stage projection set is not acknowledged");
  }
  const artifactId = createArtifactId();
  await publishArtifact({ worktree, artifactId, ...reconciliation, build, writeManifest });
  completeBuildStage(jobId);
  const requestedAt = now();
  const target = configuredTarget(env, worktree);
  const request = await writeReloadRequest({
    jobId,
    jobVersion: reconciliation.jobVersion,
    artifactId,
    stageContentHashes: reconciliation.stageContentHashes,
    buildCompletedAt: requestedAt,
    target,
  }, { spoolDir });
  patchJob(jobId, {
    publication: {
      generation: Number(readJob(jobId)?.publication?.generation ?? 0) + 1,
      requestId: request.id,
      artifactId,
      jobVersion: reconciliation.jobVersion,
      stageContentHashes: reconciliation.stageContentHashes,
      requestedAt,
    },
  });
}

function markVocProgress(jobId, asins) {
  asins.forEach(asin => markAsinModule(jobId, asin, "alexa_voc", {
    status: "manual",
    reason: "需人工录入 Alexa VOC",
  }));
}

function setAlexaManualStage(jobId, asins, vocPending, alexaDeadline) {
  patchSyncJob(jobId, {
    message: `${asins.length} 个 ASIN 的 Alexa VOC 需人工录入`,
    alexaVoc: {
      pendingAsins: vocPending.map(item => item.asin),
      estimatedSeconds: estimateAlexaVocSeconds(vocPending.length, { auto: false }),
      deadlineAt: alexaDeadline,
    },
  });
  markVocProgress(jobId, asins);
  setStage(jobId, "alexa_voc", {
    status: "manual",
    startedAt: new Date().toISOString(),
  });
}

function activateStage(jobId, stageId) {
  const now = new Date().toISOString();
  mutateSyncJob(jobId, (job) => ({
    ...job,
    stages: job.stages.map(stage => {
      if (stage.id === stageId) return { ...stage, status: "active", startedAt: stage.startedAt ?? now };
      if (stage.status === "active") return { ...stage, status: "done", completedAt: now };
      return stage;
    }),
    currentStageId: stageId,
    status: ["base-ready", "enriching"].includes(job.status) ? job.status : "running",
  }));
}

function completeStage(jobId, stageId) {
  const now = new Date().toISOString();
  setStage(jobId, stageId, { status: "done", completedAt: now });
}

export function markPersistedStageProgress(
  jobId,
  stageId,
  asins,
  {
    readReadiness = readAsinStageReadiness,
    markModule = markAsinModule,
  } = {},
) {
  const readiness = readReadiness(stageId, asins);
  for (const item of readiness.items) {
    markModule(jobId, item.asin, stageId, {
      status: isAsinStageReady(item, stageId) ? "ready" : "upstream-empty",
      reason: isAsinStageReady(item, stageId) ? null : "上游未返回可用数据",
    });
  }
  return readiness;
}

export function applyPersistedStagePostcondition(
  jobId,
  stageId,
  asins,
  {
    commandSucceeded = true,
    unavailableReason = null,
    resultStatusesByAsin = null,
    readReadiness = readAsinStageReadiness,
    markModule = markAsinModule,
    updateStage = setStage,
    commitStage = commitProjectableStage,
    projectOutput = projectStageOutput,
    readJob = readSyncJob,
    now = () => new Date().toISOString(),
    terminalStatus = null,
    gapReasonCode = null,
    stageDetail = null,
  } = {},
) {
  const readiness = markPersistedStageProgress(jobId, stageId, asins, { readReadiness, markModule });

  for (const asin of asins) {
    const reported = resultStatusesByAsin?.[asin];
    if (["ready", "upstream-empty", "timeout", "connector-failed"].includes(reported)) {
      markModule(jobId, asin, stageId, {
        status: reported,
        reason: reported === "ready" ? null : "连接器记录的局部结果",
      });
    }
  }

  const completedAt = now();
  if (!commandSucceeded) {
    for (const missingAsin of readiness.missingAsins) {
      if (resultStatusesByAsin?.[missingAsin]) continue;
      if (resultStatusesByAsin) continue;
      markModule(jobId, missingAsin, stageId, {
        status: "connector-failed",
        reason: unavailableReason ?? "连接器未完成该 ASIN",
      });
    }
  }
  const statuses = readiness.items.map(item => {
    const reported = resultStatusesByAsin?.[item.asin];
    if (["ready", "upstream-empty", "timeout", "connector-failed"].includes(reported)) return reported;
    if (isAsinStageReady(item, stageId)) return "ready";
    return commandSucceeded || resultStatusesByAsin ? "upstream-empty" : "connector-failed";
  });
  const localStatus = commandSucceeded && !readiness.missingAsins.length
    ? "done"
    : (commandSucceeded ? aggregateAsinModuleStatuses(statuses) : "partial");
  const reconciledStatus = readJob(jobId)
    ? reconcileStageStatus(readJob(jobId), stageId).status
    : localStatus;
  const status = terminalStatus ?? reconciledStatus;
  const stagePatch = {
    status,
    detail: stageDetail ?? (readiness.missingAsins.length
      ? (unavailableReason ?? `${readiness.missingAsins.length}/${asins.length} 个 ASIN 的 ${stageId} 未返回可用数据`)
      : (commandSucceeded ? undefined : `${stageId} 连接器未完成`)),
    completedAt,
  };
  if (
    updateStage === setStage &&
    isProjectableSyncStage(stageId) &&
    ["done", "partial", "failed"].includes(status)
  ) {
    const projectionAsins = readJob(jobId)?.asins ?? asins;
    commitStage(jobId, {
      stageId,
      stagePatch,
      output: projectOutput(stageId, projectionAsins, {
        stageStatus: status,
        gapReasonCode: gapReasonCode ?? (commandSucceeded ? "UPSTREAM_EMPTY" : "CONNECTOR_FAILED"),
        updatedAt: completedAt,
      }),
    });
  } else {
    updateStage(jobId, stageId, stagePatch);
  }
  return { status, missingAsins: readiness.missingAsins };
}

export function finalizeCachedStage(
  jobId,
  stageId,
  asins,
  {
    finalizeProjectable = applyPersistedStagePostcondition,
    markProgress = markPersistedStageProgress,
    updateStage = setStage,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (isProjectableSyncStage(stageId)) {
    return finalizeProjectable(jobId, stageId, asins);
  }
  const readiness = markProgress(jobId, stageId, asins);
  updateStage(jobId, stageId, { status: "skipped", completedAt: now() });
  return { status: "skipped", missingAsins: readiness?.missingAsins ?? [] };
}

export function finalizeProcessedStageCohort(
  jobId,
  stageId,
  processedAsins,
  requestedAsins,
  {
    initialJob,
    finalizeProjectable = applyPersistedStagePostcondition,
    ...processedOptions
  } = {},
) {
  if (!isProjectableSyncStage(stageId)) {
    throw new TypeError(`Stage ${stageId} cannot be projected`);
  }
  const processed = new Set(processedAsins);
  const cachedAsins = requestedAsins.filter(asin =>
    !processed.has(asin) && initialJob?.asinProgress?.[asin]?.[stageId]?.status === "pending"
  );
  const processedResult = processedAsins.length
    ? finalizeProjectable(jobId, stageId, processedAsins, processedOptions)
    : null;
  if (!cachedAsins.length) return processedResult;
  const cachedOptions = {
    commandSucceeded: true,
    ...(!processedOptions.commandSucceeded
      ? { gapReasonCode: processedOptions.gapReasonCode ?? "CONNECTOR_FAILED" }
      : {}),
    ...(processedOptions.terminalStatus ? { terminalStatus: processedOptions.terminalStatus } : {}),
    ...(processedOptions.stageDetail ? { stageDetail: processedOptions.stageDetail } : {}),
  };
  return finalizeProjectable(jobId, stageId, cachedAsins, cachedOptions);
}

function publicationContentMismatch(message) {
  const error = new Error(message);
  error.code = "WEB_PUBLICATION_CONTENT_MISMATCH";
  return error;
}

function projectFinalStageHashes(jobId, job, projectOutput) {
  if (!job || job.jobId !== jobId || !Number.isSafeInteger(job.jobVersion) || job.jobVersion < 1) {
    throw publicationContentMismatch("Final persisted job identity is unavailable");
  }
  const terminalStages = new Map((job.stages ?? [])
    .filter(stage => isProjectableSyncStage(stage?.id) && ["done", "partial", "failed"].includes(stage?.status))
    .map(stage => [stage.id, stage]));
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  const outputsByStage = new Map();
  for (const output of outputs) {
    if (!isProjectableSyncStage(output?.stage) || outputsByStage.has(output.stage)) {
      throw publicationContentMismatch("Final persisted stage projections are invalid");
    }
    outputsByStage.set(output.stage, output);
  }
  if (!terminalStages.size) throw publicationContentMismatch("Final persisted stage projections are missing");

  const stageContentHashes = {};
  for (const [stageId, stage] of terminalStages) {
    const persisted = outputsByStage.get(stageId);
    if (
      !persisted ||
      persisted.stageStatus !== stage.status ||
      typeof persisted.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(persisted.contentHash)
    ) {
      throw publicationContentMismatch(`Persisted ${stageId} projection is missing`);
    }
    let projected;
    try {
      projected = projectOutput(stageId, job.asins ?? [], {
        stageStatus: persisted.stageStatus,
        gapReasonCode: persisted.gap?.reasonCode,
        updatedAt: persisted.updatedAt,
      });
    } catch {
      throw publicationContentMismatch(`Persisted ${stageId} projection could not be reconciled`);
    }
    if (projected?.contentHash !== persisted.contentHash) {
      throw publicationContentMismatch(`Persisted ${stageId} projection content differs from its source`);
    }
    stageContentHashes[stageId] = persisted.contentHash;
  }
  if (outputsByStage.size !== terminalStages.size) {
    throw publicationContentMismatch("Final persisted stage projection set is stale");
  }
  return Object.freeze(Object.fromEntries(Object.entries(stageContentHashes).sort(([left], [right]) => left.localeCompare(right))));
}

function stageHashesMatch(candidate, expected) {
  return Boolean(
    candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    Object.keys(candidate).length === Object.keys(expected).length &&
    Object.entries(expected).every(([stage, hash]) => candidate[stage] === hash)
  );
}

function tryRunProviderCommand(label, command, args, env = {}) {
  try {
    return { succeeded: true, ...runCommand(label, command, args, env) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[warn] ${message}`);
    return {
      succeeded: false,
      diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : [],
    };
  }
}

export function diagnosticStatusesByAsin(asins, diagnostics) {
  const allowed = new Set(asins);
  const statuses = {};
  for (const diagnostic of diagnostics ?? []) {
    if (!allowed.has(diagnostic.asin)) continue;
    statuses[diagnostic.asin] = diagnostic.failureKind === "timeout"
      ? "timeout"
      : "connector-failed";
  }
  return statuses;
}

export function diagnosticsForInvocation(diagnostics, { connector, stage, asins }) {
  const requestedAsins = new Set(asins);
  return (diagnostics ?? []).filter(diagnostic =>
    diagnostic.connector === connector
    && diagnostic.stage === stage
    && requestedAsins.has(diagnostic.asin)
  );
}

export function jobProviderEnvironment(jobId, stage, env = {}) {
  return {
    ...env,
    AGENT_SYNC_JOB_ID: jobId,
    AGENT_SYNC_STAGE_ID: stage,
  };
}

function createJobProviderController(jobId) {
  const tracker = createProviderDegradationTracker({ threshold: 1 });
  const diagnostics = [];
  const persist = () => patchSyncJob(jobId, {
    diagnostics: diagnostics.slice(-32),
    providerDegraded: tracker.snapshot(),
  });
  return Object.freeze({
    run({ connector, stage, asins, label, command, args, env, allowScopedEvidenceFallback = false }) {
      const dispatch = providerDispatchPlan({
        connectorDegraded: tracker.isDegraded(connector),
        allowScopedEvidenceFallback,
        env,
      });
      if (dispatch.skip) {
        const skipped = tracker.skipDiagnostics(connector, stage, asins);
        diagnostics.push(...skipped);
        persist();
        return {
          succeeded: false,
          diagnostics: skipped,
          statusesByAsin: diagnosticStatusesByAsin(asins, skipped),
        };
      }
      const result = tryRunProviderCommand(
        label,
        command,
        args,
        jobProviderEnvironment(jobId, stage, dispatch.env),
      );
      const invocationDiagnostics = diagnosticsForInvocation(result.diagnostics, { connector, stage, asins });
      diagnostics.push(...invocationDiagnostics);
      tracker.recordAll(invocationDiagnostics);
      persist();
      return {
        ...result,
        diagnostics: invocationDiagnostics,
        statusesByAsin: diagnosticStatusesByAsin(asins, invocationDiagnostics),
      };
    },
  });
}

export function providerDispatchPlan({ connectorDegraded, allowScopedEvidenceFallback = false, env = {} }) {
  if (!connectorDegraded) return { skip: false, env };
  if (!allowScopedEvidenceFallback) return { skip: true, env };
  return {
    skip: false,
    env: { ...env, SORFTIME_SCOPED_EVIDENCE_ONLY: "1" },
  };
}

export function executeAsinStage({ asins, pendingAsins, invoke, apply }) {
  const pending = new Set(pendingAsins);
  return asins.map(asin => {
    let commandSucceeded = true;
    if (pending.has(asin)) {
      try {
        invoke(asin);
      } catch {
        commandSucceeded = false;
      }
    }
    apply(asin, commandSucceeded);
    return { asin, commandSucceeded };
  });
}

export function runCatalogStage({
  asins,
  catalogPending,
  marketplace,
  catalogProviderPlan = null,
  providers,
  asinsNeedingCatalog = asinsNeedingCatalogSync,
  apply,
}) {
  const unavailableConnectorIds = new Set(catalogProviderPlan?.unavailableConnectorIds ?? []);
  const skipSellerSprite = catalogProviderPlan?.preferredConnectorId === "sorftime"
    || unavailableConnectorIds.has("sellerSprite");
  if (!skipSellerSprite) {
    executeAsinStage({
      asins: catalogPending,
      pendingAsins: catalogPending,
      invoke: asin => {
        const result = providers.run({
          connector: "sellerSprite",
          stage: "catalog",
          asins: [asin],
          label: "catalog:sync",
          command: "npm",
          args: ["run", "catalog:sync"],
          env: { SELLERSPRITE_ASINS: asin, SELLERSPRITE_MARKETPLACE: marketplace },
        });
        if (!result.succeeded) throw new Error("catalog provider unavailable");
      },
      apply: () => {},
    });
  }

  const stillMissing = asinsNeedingCatalog(catalogPending);
  let fallbackResult = null;
  if (stillMissing.length && !unavailableConnectorIds.has("sorftime")) {
    try {
      fallbackResult = providers.run({
        connector: "sorftime",
        stage: "catalog",
        asins: stillMissing,
        label: "catalog:sorftime:sync",
        command: "npm",
        args: ["run", "catalog:sorftime:sync"],
        env: { SORFTIME_ASINS: stillMissing.join(","), SORFTIME_MARKETPLACE: marketplace },
      });
    } catch {
      fallbackResult = { succeeded: false };
    }
  }

  for (const asin of asins) {
    apply(asin, asinsNeedingCatalog([asin]).length === 0);
  }
  return { stillMissing, fallbackResult };
}

function catalogProviderPlanForJob(job) {
  const plan = job?.stages?.find(stage => stage.id === "catalog")?.catalogProviderPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  if (!(["sellerSprite", "sorftime"].includes(plan.preferredConnectorId))) return null;
  if (!Array.isArray(plan.unavailableConnectorIds) || plan.unavailableConnectorIds.length > 1) return null;
  if (new Set(plan.unavailableConnectorIds).size !== plan.unavailableConnectorIds.length) return null;
  if (!plan.unavailableConnectorIds.every(connectorId => ["sellerSprite", "sorftime"].includes(connectorId))) return null;
  if (plan.unavailableConnectorIds.includes(plan.preferredConnectorId)) return null;
  if (plan.preferredConnectorId === "sorftime" && !plan.unavailableConnectorIds.includes("sellerSprite")) return null;
  return plan;
}

async function main() {
  loadLocalEnv();
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: node scripts/run-asin-sync-job.mjs <jobId>");
    process.exitCode = 1;
    return;
  }

  const job = readSyncJob(jobId);
  if (!job) {
    console.error(`[error] job not found: ${jobId}`);
    process.exitCode = 1;
    return;
  }

  markPreflightUnavailableStages(jobId, job);
  const { asins, marketplace } = job;
  const catalogProviderPlan = catalogProviderPlanForJob(job);
  const catalogPending = asinsForSyncStage(job, "catalog", asinsNeedingCatalogSync(asins), asins);
  const providers = createJobProviderController(jobId);

  try {
    if (shouldRunSyncStage(job, "queue")) {
      activateStage(jobId, "queue");
      patchSyncJob(jobId, {
        message: catalogPending.length
          ? `准备同步 ${asins.length} 个 ASIN（${catalogPending.length} 个待入库底库）`
          : `准备同步 ${asins.length} 个 ASIN 的 MCP 数据`,
      });
      completeStage(jobId, "queue");
    }
    if (shouldRunSyncStage(job, "alexa_voc")) {
      setAlexaManualStage(jobId, asins, asins.map(asin => ({ asin })), new Date().toISOString());
    }

    if (shouldRunSyncStage(job, "catalog") && catalogPending.length) {
      activateStage(jobId, "catalog");
      patchSyncJob(jobId, { message: `卖家精灵底库入库 · ${catalogPending.length} 个 ASIN` });
      runCatalogStage({
        asins,
        catalogPending,
        marketplace,
        catalogProviderPlan,
        providers,
        apply: (asin, commandSucceeded) => applyPersistedStagePostcondition(jobId, "catalog", [asin], { commandSucceeded }),
      });
    } else if (shouldRunSyncStage(job, "catalog")) {
      finalizeCachedStage(jobId, "catalog", asins);
    }

    const needing = asinsNeedingMcpSync(asins);
    const mcpAsins = needing.map(item => item.asin);
    const stageAsins = (stageId) => asinsForSyncStage(job, stageId, mcpAsins, asins);
    const mcpStageIds = [
      "keywords",
      "reviews",
      "sales_trend",
      "child_sales",
      "price_strategy",
      "fba",
    ];
    const hasMcpWork = mcpAsins.length > 0 || mcpStageIds.some(stageId => stageAsins(stageId).length > 0);

    if (hasMcpWork) {
      const keywordAsins = stageAsins("keywords");
      if (shouldRunSyncStage(job, "keywords") && keywordAsins.length) {
        activateStage(jobId, "keywords");
        patchSyncJob(jobId, { message: `SIF 关键词 MCP · ${mcpAsins.length} 个 ASIN` });
        const keywordsResult = providers.run({
          connector: "sif", stage: "keywords", asins: keywordAsins,
          label: "keywords:sync", command: "npm", args: ["run", "keywords:sync"],
          env: { SIF_ASINS: keywordAsins.join(","), SIF_MARKETPLACE: marketplace },
        });
        finalizeProcessedStageCohort(jobId, "keywords", keywordAsins, asins, {
          initialJob: job,
          commandSucceeded: keywordsResult.succeeded,
          resultStatusesByAsin: keywordsResult.statusesByAsin,
        });
      }

      const reviewAsins = stageAsins("reviews");
      if (shouldRunSyncStage(job, "reviews") && reviewAsins.length) {
        activateStage(jobId, "reviews");
        patchSyncJob(jobId, { message: `Sorftime 评分 / 评论 + 评论分析 · ${mcpAsins.length} 个 ASIN` });
        const ratingResult = providers.run({
          connector: "sorftime", stage: "reviews", asins: reviewAsins,
          label: "rating:sync", command: "npm", args: ["run", "rating:sync"],
          env: { SORFTIME_ASINS: reviewAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
        });
        const reviewResult = providers.run({
          connector: "sorftime", stage: "reviews", asins: reviewAsins,
          label: "review:sync", command: "npm", args: ["run", "review:sync"],
          env: { SORFTIME_ASINS: reviewAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
        });
        const reviewDiagnostics = [...ratingResult.diagnostics, ...reviewResult.diagnostics];
        finalizeProcessedStageCohort(jobId, "reviews", reviewAsins, asins, {
          initialJob: job,
          commandSucceeded: ratingResult.succeeded && reviewResult.succeeded,
          resultStatusesByAsin: diagnosticStatusesByAsin(reviewAsins, reviewDiagnostics),
        });
      }

      const salesAsins = stageAsins("sales_trend");
      if (shouldRunSyncStage(job, "sales_trend") && salesAsins.length) {
        activateStage(jobId, "sales_trend");
        patchSyncJob(jobId, { message: `Sorftime 销量趋势 · ${mcpAsins.length} 个 ASIN` });
        const salesResult = providers.run({
          connector: "sorftime", stage: "sales_trend", asins: salesAsins,
          label: "sales:sync", command: "npm", args: ["run", "sales:sync"],
          env: { SORFTIME_ASINS: salesAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
        });
        finalizeProcessedStageCohort(jobId, "sales_trend", salesAsins, asins, {
          initialJob: job,
          commandSucceeded: salesResult.succeeded,
          resultStatusesByAsin: salesResult.statusesByAsin,
        });
      }

      const childAsins = stageAsins("child_sales");
      if (shouldRunSyncStage(job, "child_sales") && childAsins.length) {
        activateStage(jobId, "child_sales");
        patchSyncJob(jobId, { message: `Sorftime 变体评论结构 + 近30天子体销量 · ${mcpAsins.length} 个 ASIN` });
        const variantResult = providers.run({
          connector: "sorftime", stage: "child_sales", asins: childAsins,
          label: "variant:sync", command: "npm", args: ["run", "variant:sync"],
          env: { SORFTIME_ASINS: childAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
        });
        const childSalesResult = providers.run({
          connector: "sorftime", stage: "child_sales", asins: childAsins,
          label: "child-sales:sync", command: "npm", args: ["run", "child-sales:sync"],
          env: { SORFTIME_ASINS: childAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
          allowScopedEvidenceFallback: true,
        });
        const childDiagnostics = childSalesResult.succeeded
          ? childSalesResult.diagnostics
          : [...variantResult.diagnostics, ...childSalesResult.diagnostics];
        applyPersistedStagePostcondition(jobId, "child_sales", childAsins, {
          commandSucceeded: childSalesResult.succeeded,
          resultStatusesByAsin: diagnosticStatusesByAsin(childAsins, childDiagnostics),
        });
      }

      const priceAsins = stageAsins("price_strategy");
      if (shouldRunSyncStage(job, "price_strategy") && priceAsins.length) {
        activateStage(jobId, "price_strategy");
        patchSyncJob(jobId, { message: `Sorftime 价格策略 · ${mcpAsins.length} 个 ASIN` });
        const priceResult = providers.run({
          connector: "sorftime", stage: "price_strategy", asins: priceAsins,
          label: "price-strategy:sync", command: "npm", args: ["run", "price-strategy:sync"],
          env: { SORFTIME_ASINS: priceAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
          allowScopedEvidenceFallback: true,
        });
        applyPersistedStagePostcondition(jobId, "price_strategy", priceAsins, {
          commandSucceeded: priceResult.succeeded,
          resultStatusesByAsin: priceResult.statusesByAsin,
        });
      }

      const fbaAsins = stageAsins("fba");
      if (shouldRunSyncStage(job, "fba") && fbaAsins.length) {
        activateStage(jobId, "fba");
        patchSyncJob(jobId, { message: `Sorftime FBA 费用 · ${mcpAsins.length} 个 ASIN` });
        const fbaResult = providers.run({
          connector: "sorftime", stage: "fba", asins: fbaAsins,
          label: "fba:sync", command: "npm", args: ["run", "fba:sync"],
          env: { SORFTIME_ASINS: fbaAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
          allowScopedEvidenceFallback: true,
        });
        finalizeProcessedStageCohort(jobId, "fba", fbaAsins, asins, {
          initialJob: job,
          commandSucceeded: fbaResult.succeeded,
          resultStatusesByAsin: fbaResult.statusesByAsin,
        });
      }
    } else if (!Array.isArray(job?.resumeStages)) {
      mcpStageIds.filter(stageId => shouldRunSyncStage(job, stageId)).forEach(stageId => {
        finalizeCachedStage(jobId, stageId, asins);
      });
    }

    const listingPending = asinsForSyncStage(
      job,
      "listing",
      asinsNeedingListingSync(asins).map((item) => item.asin),
      asins,
    );
    const trafficPending = asinsForSyncStage(
      job,
      "traffic",
      asinsNeedingTrafficSync(asins).map((item) => item.asin),
      asins,
    );

    if (shouldRunSyncStage(job, "listing") && listingPending.length) {
      activateStage(jobId, "listing");
      patchSyncJob(jobId, { message: `Sorftime Listing 主辅图 / A+ · ${listingPending.length} 个 ASIN` });
      const listingAsins = listingPending;
      const listingResult = providers.run({
        connector: "sorftime", stage: "listing", asins: listingAsins,
        label: "listing:sync", command: "npm", args: ["run", "listing:sync"],
        env: { SORFTIME_ASINS: listingAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
        allowScopedEvidenceFallback: true,
      });
      finalizeProcessedStageCohort(jobId, "listing", listingAsins, asins, {
        initialJob: job,
        commandSucceeded: listingResult.succeeded,
        resultStatusesByAsin: listingResult.statusesByAsin,
      });
    } else if (shouldRunSyncStage(job, "listing")) {
      finalizeCachedStage(jobId, "listing", asins);
    }

    const reactivatedImageAsins = reactivateImageRemarksForReadyGalleries(jobId, asins);

    const categoryAsins = stageAsins("category");
    if (shouldRunSyncStage(job, "category") && categoryAsins.length) {
      activateStage(jobId, "category");
      patchSyncJob(jobId, { message: `Sorftime BSR 小类趋势 · ${mcpAsins.length} 个 ASIN` });
      const categoryResult = providers.run({
        connector: "sorftime", stage: "category", asins: categoryAsins,
        label: "category:sync", command: "npm", args: ["run", "category:sync"],
        env: { SORFTIME_ASINS: categoryAsins.join(","), SORFTIME_MARKETPLACE: marketplace },
        allowScopedEvidenceFallback: true,
      });
      const permanentConnectTimeout = !categoryResult.succeeded && categoryResult.diagnostics.some(diagnostic =>
        diagnostic.connector === "sorftime" &&
        diagnostic.stage === "category" &&
        diagnostic.causeCode === "CONNECT_TIMEOUT"
      );
      finalizeProcessedStageCohort(jobId, "category", categoryAsins, asins, {
        initialJob: job,
        commandSucceeded: categoryResult.succeeded,
        resultStatusesByAsin: categoryResult.statusesByAsin,
        ...(permanentConnectTimeout
          ? { terminalStatus: "failed", gapReasonCode: "CONNECT_TIMEOUT" }
          : {}),
      });
    } else if (shouldRunSyncStage(job, "category")) {
      finalizeCachedStage(jobId, "category", asins);
    }

    if (shouldRunSyncStage(job, "traffic") && trafficPending.length) {
      activateStage(jobId, "traffic");
      patchSyncJob(jobId, { message: `SIF 竞品流量结构 · ${trafficPending.length} 个 ASIN` });
      const pendingTrafficAsins = new Set(trafficPending);
      for (const asin of asins) {
        if (!pendingTrafficAsins.has(asin)) {
          applyPersistedStagePostcondition(jobId, "traffic", [asin], { commandSucceeded: true });
          continue;
        }
        const trafficResult = providers.run({
          connector: "sif", stage: "traffic", asins: [asin],
          label: "traffic:sync", command: "npm", args: ["run", "traffic:sync"],
          env: { SIF_ASINS: asin, SIF_MARKETPLACE: marketplace },
        });
        applyPersistedStagePostcondition(jobId, "traffic", [asin], {
          commandSucceeded: trafficResult.succeeded,
          resultStatusesByAsin: trafficResult.statusesByAsin,
        });
      }
    } else if (shouldRunSyncStage(job, "traffic")) {
      finalizeCachedStage(jobId, "traffic", asins);
    }

    const imageStageJob = readSyncJob(jobId);
    const imageAsins = imageRemarkRunAsins(imageStageJob, asins);
    const trafficIsTerminal = imageAsins.length > 0 && imageAsins.every(asin =>
      trafficIsTerminalBeforeImageRemarks(imageStageJob?.asinProgress?.[asin])
    );
    if ((shouldRunSyncStage(job, "image_remarks") || reactivatedImageAsins.length > 0) && trafficIsTerminal) {
      activateStage(jobId, "image_remarks");
      setStage(jobId, "image_remarks", {
        status: "active",
        detail: "图片 AI 备注：等待处理（并发 4，单图最长 120 秒）",
      });
      patchSyncJob(jobId, { message: "正在自动生成图片 AI 备注…" });
      let latestImageStageDetail = null;
      const imageProcess = await runImageRemarkProcess({
        command: "npm",
        args: ["run", "image-remarks:sync"],
        cwd: root,
        env: {
          ...process.env,
          REMARK_ASINS: imageAsins.join(","),
          AGENT_SYNC_JOB_ID: jobId,
          AGENT_SYNC_STAGE_ID: "image_remarks",
          AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "1",
        },
        onProgress: (event) => {
          latestImageStageDetail = formatImageRemarkStageDetail(event);
          setStage(jobId, "image_remarks", {
            status: "active",
            detail: latestImageStageDetail,
          });
        },
        onOutput: text => process.stdout.write(sanitizeCommandOutput(text)),
      });
      applyPersistedStagePostcondition(jobId, "image_remarks", imageAsins, {
        commandSucceeded: imageProcess.succeeded,
        resultStatusesByAsin: readImageRemarkStatuses(),
        unavailableReason: imageProcess.succeeded ? null : "图片 AI 备注存在明确缺口",
        stageDetail: latestImageStageDetail,
      });
    }

    if (shouldRunSyncStage(job, "build") && shouldBuildForSync(process.env)) {
      activateStage(jobId, "build");
      patchSyncJob(jobId, { message: "正在构建前端包并请求受控 Web 刷新…" });
      await publishWebBuild(jobId);
    } else if (shouldRunSyncStage(job, "build")) {
      setStage(jobId, "build", {
        status: "skipped",
        detail: "本机 fake 模式跳过前端构建与受控 Web 刷新请求。",
        completedAt: new Date().toISOString(),
      });
    }

    markSyncJobBaseReady(jobId);

    const finalStatus = deriveFinalSyncJobStatus(readSyncJob(jobId)?.asinProgress) ?? "completed-with-gaps";
    patchSyncJob(jobId, {
      status: finalStatus,
      message: finalStatus === "completed"
        ? "基础数据同步已完成。"
        : "同步完成，部分 ASIN 或模块存在明确缺口。",
      completedAt: new Date().toISOString(),
      needsReload: true,
    });
    console.log(`[done] job ${jobId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    failSyncJob(jobId, message);
    process.exitCode = 1;
  }
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) main();
