import { runSorftimeCommand } from "./lib/sorftime-stream.mjs";
import { childSalesResultStatuses } from './lib/child-sales-outcomes.mjs';
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generatedAppDataPath } from "./lib/generated-app-data-path.mjs";
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
  readAsinStatusSources,
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
  persistedStageOutputContentHash,
  projectStageOutput,
} from "./lib/sync-stage-output.mjs";
import {
  imageCandidateReadiness,
  imageCandidateResultStatuses,
  mergeImageRemarkStageData,
  readImageRemarkCandidate,
  validatePersistedImageStageOutput,
} from "./lib/image-remark-job-candidate.mjs";
import { readCachedDataExport } from "./lib/sync-cache.mjs";
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
import { captureCatalogForSyncJob } from "./lib/catalog-sync.mjs";
import { asinsNeedingSorftimeCatalogSync } from "./lib/sorftime-catalog-fallback.mjs";
import { listingInputFromPersistedJob, partitionImageListingInput } from "./lib/image-remark-listing-input.mjs";
import { resolveRuntimeRoots } from "./lib/runtime-roots.mjs";

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
  const stage = job?.stages?.find(stage => stage.id === "image_remarks");
  const planned = stage?.repairAsins;
  return asins.filter(asin => (!Array.isArray(planned) || planned.includes(asin))
    && (stage?.imageAction !== "refresh" || job?.asinProgress?.[asin]?.listing?.status === "ready")
    && (stage?.imageAction || job?.asinProgress?.[asin]?.image_remarks?.status === "pending"));
}

/** A fresh scoped job must freeze its own URL-validated cache evidence. */
export function needsImageRemarkCapture(job, asins) {
  if (!job?.scope?.organizationId) return false;
  const listing = job.outputs?.find(output => output.stage === "listing")?.data?.contentByAsin ?? {};
  const expected = asins.filter(asin => listing[asin]?.status === "ready" && listing[asin]?.galleryImages?.length);
  const saved = job.outputs?.find(output => output.stage === "image_remarks");
  if (saved?.stageStatus === "failed" && !expected.length && asins.every(asin =>
    TERMINAL_ASIN_STATUSES.has(job.asinProgress?.[asin]?.image_remarks?.status))) return false;
  return !saved?.data || expected.some(asin => !Array.isArray(saved.data.remarksByAsin?.[asin]) ||
    !Array.isArray(saved.data.outcomesByAsin?.[asin]));
}

/** Shared by main's late capture gate; provider selection remains separate. */
export function imageRemarkScheduling(initialJob, currentJob, asins, reactivated = false) {
  const stage = currentJob?.stages?.find(item => item.id === "image_remarks");
  const resumeAllowed = !Array.isArray(initialJob?.resumeStages) || initialJob.resumeStages.includes("image_remarks");
  const providerAllowed = resumeAllowed && (shouldRunSyncStage(initialJob, "image_remarks") || reactivated);
  const analysisAsins = providerAllowed ? imageRemarkRunAsins(currentJob, asins) : [];
  const captureNeeded = needsImageRemarkCapture(currentJob, asins);
  const captureAsins = currentJob?.scope?.organizationId && resumeAllowed
    ? partitionImageListingInput(currentJob, asins).readyAsins : asins;
  const hasWork = analysisAsins.length > 0 || (resumeAllowed && captureNeeded && asins.length > 0);
  const trafficCohort = captureAsins.length === 0 ? asins : captureNeeded ? captureAsins : analysisAsins;
  const trafficTerminal = (captureAsins.length > 0 && Boolean(stage?.imageAction)) || trafficCohort.every(asin => {
    const progress = currentJob?.asinProgress?.[asin];
    return TERMINAL_ASIN_STATUSES.has(progress?.traffic?.status ?? progress?.traffic);
  });
  return { analysisAsins, captureAsins, captureNeeded, shouldRun: hasWork && trafficTerminal };
}

/** Only the validated gallery cohort may reach the image subprocess. */
export async function runGalleryReadyImageProcess(job, asins, dispatch) {
  const partition = partitionImageListingInput(job, asins);
  const process = partition.readyAsins.length
    ? await dispatch(partition.readyAsins)
    : { succeeded: true };
  return { ...partition, process };
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
  const repairAsins = job?.stages?.find(stage => stage.id === stageId)?.repairAsins;
  if (Array.isArray(repairAsins)) return requestedAsins.filter(asin => repairAsins.includes(asin));
  if (!Array.isArray(job?.resumeStages)) return [...readinessCandidates];
  if (!job.resumeStages.includes(stageId)) return [];
  return requestedAsins.filter((asin) =>
    resumableRepairStatuses.has(job.asinProgress?.[asin]?.[stageId]?.status)
  );
}

export function repairProviderEnvironment(job, stageId, env = {}) {
  return Array.isArray(job?.stages?.find(stage => stage.id === stageId)?.repairAsins)
    ? { ...env, FORCE_REFRESH: "0", AGENT_SYNC_REPAIR_INCOMPLETE: "1", ...(job.stages.find(stage => stage.id === stageId)?.imageAction ? {AGENT_SYNC_IMAGE_ACTION:job.stages.find(stage => stage.id === stageId).imageAction} : {}) }
    : env;
}

export function finalizeRepairCachedStages(jobId, job, finalize = finalizeCachedStage) {
  for (const stage of job?.stages ?? []) {
    if (Array.isArray(stage.repairAsins) && stage.repairAsins.length === 0) {
      if (stage.id === "image_remarks" && needsImageRemarkCapture(job, job.asins)) continue;
      finalize(jobId, stage.id, job.asins);
    }
  }
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
    persistenceTimeoutMs = 10_000,
    persistencePollIntervalMs = 100,
    persistenceNow = () => Date.now(),
    waitForPersistence = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  const initialJob = readJob(jobId);
  const recovery = isPersistedOutputRecovery(initialJob);
  const hashesFor = recovery ? projectRecoveredStageHashes :
    (currentJobId, job) => projectFinalStageHashes(currentJobId, job, projectOutput);
  const expectedHashes = hashesFor(jobId, initialJob);
  let reconciliation = null;
  const persistenceDeadline = persistenceNow() + persistenceTimeoutMs;
  let firstAttempt = true;
  while (true) {
    const candidate = firstAttempt ? initialJob : readJob(jobId);
    firstAttempt = false;
    const candidateHashes = hashesFor(jobId, candidate);
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
    const remainingMs = persistenceDeadline - persistenceNow();
    if (remainingMs <= 0) break;
    await waitForPersistence(Math.min(persistencePollIntervalMs, remainingMs));
  }
  if (!reconciliation) {
    throw publicationContentMismatch("Final persisted stage projection set is not acknowledged");
  }
  const artifactId = createArtifactId();
  await publishArtifact({ worktree, artifactId, ...reconciliation, build, writeManifest, captureSourceIdentity: true });
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
    resultReasonsByAsin = null,
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
    diagnostics = [],
    imageRemarksData = null,
  } = {},
) {
  // Validate old frozen image coverage against the progress it accompanied,
  // before this cohort's newly captured successes change module readiness.
  const imageSourceJob = stageId === "image_remarks" ? structuredClone(readJob(jobId)) : null;
  const readiness = markPersistedStageProgress(jobId, stageId, asins, { readReadiness, markModule });

  for (const asin of asins) {
    const reported = resultStatusesByAsin?.[asin];
    if (["ready", "upstream-empty", "timeout", "connector-failed"].includes(reported)) {
      markModule(jobId, asin, stageId, {
        status: reported,
        reason: reported === "ready" ? null : resultReasonsByAsin?.[asin] ??
          (diagnostics.some(item => item.asin === asin && item.stage === stageId && item.causeCode === "PROVIDER_DEGRADED")
            ? "数据源连接异常，保护机制已跳过本次请求，可补抓未完成项"
            : "连接器记录的局部结果"),
      });
    }
  }

  const completedAt = now();
  if (!commandSucceeded) {
    for (const missingAsin of readiness.missingAsins) {
      if (resultStatusesByAsin?.[missingAsin]) continue;
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
    return commandSucceeded ? "upstream-empty" : "connector-failed";
  });
  const localStatus = commandSucceeded && !readiness.missingAsins.length
    ? "done"
    : (commandSucceeded ? aggregateAsinModuleStatuses(statuses) : "partial");
  const currentJob = readJob(jobId);
  const reconciledStatus = currentJob
    ? reconcileStageStatus(currentJob, stageId).status
    : localStatus;
  const status = terminalStatus ?? reconciledStatus;
  const readyAsins = readiness.items.flatMap((item, index) => statuses[index] === "ready" ? [item.asin] : []);
  const gapItems = boundedDiagnosticGapItems(diagnostics, asins, readyAsins);
  for (const [index, item] of readiness.items.entries()) {
    if (gapItems.some(gap => gap.asin === item.asin) || statuses[index] === "ready") continue;
    gapItems.push({ asin: item.asin, causeCode: statuses[index] === "timeout" ? "CONNECT_TIMEOUT"
      : statuses[index] === "upstream-empty" ? "UPSTREAM_EMPTY" : "CONNECTOR_FAILED" });
  }
  const cohortStatuses = currentJob?.asins?.map(asin => currentJob.asinProgress?.[asin]?.[stageId]?.status);
  let cohortDetail;
  if (cohortStatuses?.length) {
    const ready = cohortStatuses.filter(value => value === "ready").length;
    const empty = cohortStatuses.filter(value => value === "upstream-empty").length;
    const failed = cohortStatuses.filter(value => ["connector-failed", "timeout"].includes(value)).length;
    const pending = cohortStatuses.length - ready - empty - failed;
    cohortDetail = `${ready}/${cohortStatuses.length} 个 ASIN 的 ${stageId} 已就绪 · 上游无结果 ${empty} · 失败 ${failed} · 待处理 ${pending}`;
    if (unavailableReason) cohortDetail = `${unavailableReason} · ${cohortDetail}`;
  }
  const stagePatch = {
    status,
    detail: stageDetail ?? cohortDetail ?? (readiness.missingAsins.length
      ? (unavailableReason ?? `${readiness.missingAsins.length}/${asins.length} 个 ASIN 的 ${stageId} 未返回可用数据`)
      : (commandSucceeded ? undefined : `${stageId} 连接器未完成`)),
    completedAt,
  };
  if (
    updateStage === setStage &&
    isProjectableSyncStage(stageId) &&
    ["done", "partial", "failed"].includes(status)
  ) {
    const projectionAsins = currentJob?.asins ?? asins;
    const processedAsins = new Set(asins);
    const projectionReadyAsins = [...new Set([
      ...readyAsins,
      ...projectionAsins.filter(asin => !processedAsins.has(asin) &&
        currentJob?.asinProgress?.[asin]?.[stageId]?.status === "ready"),
    ])];
    // Per-ASIN stages publish repeatedly. Preserve sibling results and their
    // bounded failure evidence, but discard old gaps for the refreshed cohort.
    const previousOutput = currentJob?.outputs?.find(output => output.stage === stageId);
    const siblingGapItems = (previousOutput?.gap?.items ?? []).filter(item =>
      projectionAsins.includes(item.asin) && !processedAsins.has(item.asin) &&
      !projectionReadyAsins.includes(item.asin));
    const projectedGapAsins = new Set(siblingGapItems.map(item => item.asin));
    const projectionGapItems = [
      ...gapItems,
      ...siblingGapItems,
      // A previous projection is the sibling's current evidence. Historical
      // diagnostics have no attempt identity; replaying them can turn a new
      // timeout back into an old schema error. Without a projection, report
      // only the cause supported by the current module state.
      ...projectionAsins.flatMap(asin => {
        if (processedAsins.has(asin) || projectedGapAsins.has(asin)) return [];
        const moduleStatus = currentJob?.asinProgress?.[asin]?.[stageId]?.status;
        if (moduleStatus === "timeout") return [{ asin, causeCode: "CONNECT_TIMEOUT" }];
        if (moduleStatus === "connector-failed") return [{ asin, causeCode: "CONNECTOR_FAILED" }];
        return [];
      }),
    ];
    commitStage(jobId, {
      stageId,
      stagePatch,
      output: projectOutput(stageId, projectionAsins, {
        jobId,
        marketplace: currentJob?.marketplace ?? currentJob?.scope?.marketplace ?? "US",
        organizationId: currentJob?.scope?.organizationId,
        projectId: currentJob?.scope?.projectId,
        runId: currentJob?.scope?.runId,
        stageStatus: status,
        gapReasonCode: gapReasonCode ?? projectionGapItems.find(item => item.causeCode !== "UPSTREAM_EMPTY")?.causeCode ?? (commandSucceeded ? "UPSTREAM_EMPTY" : "CONNECTOR_FAILED"),
        gapItems: projectionGapItems,
        dataAsins: status === "partial" ? projectionReadyAsins : projectionAsins,
        updatedAt: completedAt,
        ...(stageId === "image_remarks"
          ? { imageRemarksData: mergeImageRemarkStageData(
            imageSourceJob ?? currentJob, previousOutput, asins,
            imageRemarksData ?? { remarksByAsin: {}, outcomesByAsin: {} },
          ) }
          : {}),
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
    if (stageId === "image_remarks" && finalizeProjectable === applyPersistedStagePostcondition) {
      const job = readSyncJob(jobId);
      const previous = job?.outputs?.find(output => output.stage === stageId);
      if (previous) validatePersistedImageStageOutput(job, previous);
      const data = previous?.data ?? { remarksByAsin: {}, outcomesByAsin: {} };
      const savedAsins = Object.keys(data.remarksByAsin ?? {});
      const listing = savedAsins.length ? listingInputFromPersistedJob(job, savedAsins) : {};
      return finalizeProjectable(jobId, stageId, asins, {
        imageRemarksData: data,
        readReadiness: (_stage, cohort) => imageCandidateReadiness(data, listing, cohort),
        resultStatusesByAsin: imageCandidateResultStatuses(data, listing, asins),
      });
    }
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
  const cohortAsins = [...new Set([...processedAsins, ...cachedAsins])];
  if (!cohortAsins.length) return null;
  if (stageId === "image_remarks" && finalizeProjectable === applyPersistedStagePostcondition) {
    // The reporting cohort includes cached families, but only the dispatched
    // ASINs replace their frozen image entries. Reconcile from scoped evidence
    // before readiness marking so cached families cannot become false gaps.
    const currentJob = (processedOptions.readJob ?? readSyncJob)(jobId);
    const previous = currentJob?.outputs?.find(output => output.stage === stageId);
    const data = mergeImageRemarkStageData(currentJob, previous, processedAsins,
      processedOptions.imageRemarksData ?? { remarksByAsin: {}, outcomesByAsin: {} });
    const savedAsins = Object.keys(data.remarksByAsin);
    const listing = savedAsins.length ? listingInputFromPersistedJob(currentJob, savedAsins) : {};
    const cohort = new Set(cohortAsins);
    const scopedData = Object.fromEntries(Object.entries(data).map(([field, entries]) =>
      [field, Object.fromEntries(Object.entries(entries).filter(([asin]) => cohort.has(asin)))]));
    const statuses = imageCandidateResultStatuses(data, listing, cohortAsins);
    for (const asin of processedAsins) {
      const reported = processedOptions.resultStatusesByAsin?.[asin];
      if (["ready", "upstream-empty", "timeout", "connector-failed"].includes(reported)) statuses[asin] = reported;
    }
    return finalizeProjectable(jobId, stageId, cohortAsins, {
      ...processedOptions,
      imageRemarksData: scopedData,
      readReadiness: (_stage, cohort) => imageCandidateReadiness(data, listing, cohort),
      resultStatusesByAsin: statuses,
    });
  }
  return finalizeProjectable(jobId, stageId, cohortAsins, processedOptions);
}

function publicationContentMismatch(message) {
  const error = new Error(message);
  error.code = "WEB_PUBLICATION_CONTENT_MISMATCH";
  return error;
}

function persistedDataAsins(stageId, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const keyed = (...keys) => keys.flatMap(key => Object.keys(data[key] ?? {}));
  if (stageId === "keywords") return keyed("analysisByAsin").filter(asin =>
    data.analysisByAsin[asin]?.status === "ready");
  // Ratings do not determine review readiness or remove bounded sample gaps.
  if (stageId === "reviews") return keyed("analysisByAsin");
  // Incomplete observation records are retained as evidence, not ready ASINs.
  if (stageId === "sales_trend") return keyed("trendByAsin").filter(asin =>
    !["empty", "error"].includes(data.trendByAsin[asin]?.status));
  if (stageId === "fba") return keyed("feeByAsin");
  if (stageId === "listing") return keyed("contentByAsin");
  if (stageId === "traffic") return keyed("listingByAsin", "monthlyByAsin");
  if (stageId === "child_sales") return keyed("rowsByAsin");
  if (stageId === "price_strategy") return keyed("strategyByAsin");
  if (stageId === "image_remarks") return keyed("remarksByAsin", "outcomesByAsin");
  return Object.values(data.trendByNode ?? {}).flatMap(record => Array.isArray(record?.asins) ? record.asins : []);
}

export function projectFinalStageHashes(jobId, job, projectOutput) {
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
    if (stageId === "image_remarks") {
      try { validatePersistedImageStageOutput(job, persisted); }
      catch { throw publicationContentMismatch("Persisted image_remarks projection does not match its listing"); }
      stageContentHashes[stageId] = persisted.contentHash;
      continue;
    }
    let projected;
    try {
      projected = projectOutput(stageId, job.asins ?? [], {
        jobId,
        marketplace: job.marketplace ?? job.scope?.marketplace ?? "US",
        organizationId: job.scope?.organizationId,
        projectId: job.scope?.projectId,
        runId: job.scope?.runId,
        stageStatus: persisted.stageStatus,
        gapReasonCode: persisted.gap?.reasonCode,
        gapItems: persisted.gap?.items ?? [],
        ...(persisted.stageStatus === "partial" ? { dataAsins: persistedDataAsins(stageId, persisted.data) } : {}),
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

export function projectRecoveredStageHashes(jobId, job) {
  if (
    !job || job.jobId !== jobId || !Number.isSafeInteger(job.jobVersion) || job.jobVersion < 1 ||
    !isPersistedOutputRecovery(job) ||
    !job.scope?.organizationId || !job.scope?.projectId || !job.scope?.runId
  ) throw publicationContentMismatch("Build recovery identity is unavailable");
  const expected = new Map((job.stages ?? [])
    .filter(stage => isProjectableSyncStage(stage?.id) && ["done", "partial", "failed"].includes(stage?.status))
    .map(stage => [stage.id, stage.status]));
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  if (expected.size !== 10 || outputs.length !== expected.size) {
    throw publicationContentMismatch("Build recovery stage projections are incomplete");
  }
  const hashes = {};
  for (const output of outputs) {
    if (
      !isProjectableSyncStage(output?.stage) || Object.hasOwn(hashes, output.stage) ||
      expected.get(output.stage) !== output.stageStatus ||
      output.organizationId !== job.scope.organizationId ||
      output.projectId !== job.scope.projectId || output.runId !== job.scope.runId ||
      typeof output.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(output.contentHash)
    ) throw publicationContentMismatch("Build recovery projection scope is invalid");
    let actualHash;
    try { actualHash = persistedStageOutputContentHash(output); }
    catch { throw publicationContentMismatch(`Persisted ${output.stage} recovery projection is invalid`); }
    if (actualHash !== output.contentHash) {
      throw publicationContentMismatch(`Persisted ${output.stage} recovery projection content differs from its hash`);
    }
    if (output.stage === "image_remarks") {
      try { validatePersistedImageStageOutput(job, output); }
      catch { throw publicationContentMismatch("Persisted image_remarks recovery projection does not match its listing"); }
    }
    hashes[output.stage] = output.contentHash;
  }
  if ([...expected.keys()].some(stage => !Object.hasOwn(hashes, stage))) {
    throw publicationContentMismatch("Build recovery projection set is incomplete");
  }
  return Object.freeze(Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))));
}

function isPersistedOutputRecovery(job) {
  const stages = job?.resumeStages;
  return Array.isArray(stages) && (
    (stages.length === 1 && stages[0] === "build") ||
    (stages.length === 2 && stages[0] === "image_remarks" && stages[1] === "build")
  );
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

const xydcSafeStopReasons = new Set([
  "XYDC_COORDINATION_ROOT_REQUIRED", "XYDC_JOB_CONTEXT_INVALID", "XYDC_JOB_PARENT_IPC_REQUIRED",
  "XYDC_JOB_DATABASE_NOT_CONFIGURED", "XYDC_COLLECTION_STOPPED",
]);

export function createXydcDiagnosticParser(asins, scopeAsins) {
    let safeReason;
    const repairStatuses = {};
    const repairOrders = {};
    const repairDetails = {};
    let diagnosticLine = "";
    let discardLine = false;
    const push = chunk => {
      if (safeReason) return;
      // Drain all stderr, but retain at most 128 ASCII bytes and never echo provider text.
      for (const byte of chunk) {
        if (byte === 10) {
          const repair = scopeAsins && !discardLine && /^\[xydc-repair\] ([A-Z0-9]{10}) (ready|upstream-empty|timeout|connector-failed)\r?$/.exec(diagnosticLine);
          if (repair && asins.includes(repair[1])) repairStatuses[repair[1]] = repair[2];
          const order = scopeAsins && !discardLine && /^\[xydc-orders\] ([A-Z0-9]{10}) (ready|upstream-empty|timeout|connector-failed)\r?$/.exec(diagnosticLine);
          if (order && asins.includes(order[1])) repairOrders[order[1]] = order[2];
          const detail = scopeAsins && !discardLine && /^\[xydc-detail\] ([A-Z0-9]{10}) ([A-Z0-9]{10}) ((?:title|imageUrl|price|currency|stars|productPageRatings)(?:,(?:title|imageUrl|price|currency|stars|productPageRatings))*)\r?$/.exec(diagnosticLine);
          if (detail && asins.includes(detail[1])) (repairDetails[detail[1]] ??= []).push({ asin: detail[2], fields: detail[3].split(",") });
          const match = !discardLine && /^\[xydc\] (XYDC_[A-Z_]+)\r?$/.exec(diagnosticLine);
          diagnosticLine = ""; discardLine = false;
          if (match && xydcSafeStopReasons.has(match[1])) { safeReason = match[1]; return; }
        } else if (!discardLine) {
          if (byte > 127 || diagnosticLine.length >= 128) { diagnosticLine = ""; discardLine = true; }
          else diagnosticLine += String.fromCharCode(byte);
        }
      }
    };
    return { push, get safeReason() { return safeReason; }, result: { repairStatuses, repairOrders, repairDetails } };
}

export function runOptionalXydcVariantEnrichment({ asins, marketplace, scopeAsins, run, env = process.env }) {
  const childEnvironment = {
    XYDC_ASINS: asins.join(","),
    XYDC_COUNTRY: marketplace,
    ...(scopeAsins ? { XYDC_JOB_ASINS: scopeAsins.join(","), FORCE_REFRESH: "0", AGENT_SYNC_REPAIR_INCOMPLETE: "1" } : {}),
  };
  if (run) {
    const result = run("variant:xydc:sync", "npm", ["run", "variant:xydc:sync"], childEnvironment);
    return Object.freeze({ succeeded: Boolean(result?.succeeded) });
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts", "build-xydc-variant-data.ts")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...env, ...childEnvironment, AGENT_XYDC_PARENT_IPC: "1" },
    });
    const parser = createXydcDiagnosticParser(asins, scopeAsins);
    const { repairStatuses, repairOrders, repairDetails } = parser.result;
    child.stderr.on("data", parser.push);
    let terminationSignal;
    const cancel = signal => { terminationSignal = signal; if (child.connected) child.disconnect(); };
    const interrupt = () => cancel("SIGINT");
    const terminate = () => cancel("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", () => {});
    child.once("close", code => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      // Preserve the runner's original termination semantics after its directly owned child has drained.
      if (terminationSignal) { process.kill(process.pid, terminationSignal); return; }
      if (code !== 0) console.error(`[warn] optional XYDC collection stopped${parser.safeReason ? `: ${parser.safeReason}` : ""}`);
      resolve(Object.freeze({ succeeded: code === 0, ...(scopeAsins ? { repairStatuses, repairOrders, repairDetails } : {}) }));
    });
  });
}

export function xydcRepairReason(result, asin) {
  const labels = { title: "标题", imageUrl: "图片", price: "价格", currency: "币种", stars: "评分", productPageRatings: "评论数" };
  const details = (result?.repairDetails?.[asin] ?? []).map(child => `${child.asin}：${child.fields.map(field => labels[field]).join("、")}未返回`).join("；");
  const orders = result?.repairOrders?.[asin] === "ready" ? "全年订单已完整" : "全年订单待补齐";
  return details ? `${orders}；${details}` : result?.repairDetails ? orders : `${orders}；子体详情待确认`;
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

export function sifKeywordSchemaDiagnostics(asins, records) {
  const allowed = new Set(asins);
  return Object.entries(records ?? {}).flatMap(([asin, record]) => (
    allowed.has(asin)
    && record?.status === "schema-error"
    && record?.errorCode === "SIF_KEYWORD_SCHEMA_INVALID"
      ? [{ asin, connector: "sif", stage: "keywords", failureKind: "schema", causeCode: "SIF_KEYWORD_SCHEMA_INVALID" }]
      : []
  ));
}

function boundedDiagnosticGapItems(diagnostics, asins, readyAsins) {
  const requested = new Set(asins);
  const ready = new Set(readyAsins);
  const allowed = new Set(["CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED", "SIF_KEYWORD_SCHEMA_INVALID", "MCP_SCHEMA"]);
  return (diagnostics ?? []).flatMap(diagnostic => {
    if (!requested.has(diagnostic?.asin) || ready.has(diagnostic.asin) || !allowed.has(diagnostic.causeCode)) return [];
    return [{
      asin: diagnostic.asin,
      causeCode: diagnostic.causeCode,
      ...(diagnostic.operation ? { operation: diagnostic.operation } : {}),
      ...(diagnostic.boundary ? { boundary: diagnostic.boundary } : {}),
      ...(diagnostic.shape ? { shape: diagnostic.shape } : {}),
    }];
  });
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

function createJobProviderController(jobId, initialJob) {
  const tracker = createProviderDegradationTracker({ threshold: 1 });
  const diagnostics = [];
  const persist = () => patchSyncJob(jobId, {
    diagnostics: diagnostics.slice(-32),
    providerDegraded: tracker.snapshot(),
  });
  return Object.freeze({
    run({ connector, stage, asins, label, command, args, env, allowScopedEvidenceFallback = false, streamingScript }) {
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
      const finish = result => {
        const invocationDiagnostics = diagnosticsForInvocation(result.diagnostics, { connector, stage, asins });
        diagnostics.push(...invocationDiagnostics);
        tracker.recordAll(invocationDiagnostics);
        persist();
        return { ...result, diagnostics: invocationDiagnostics,
          statusesByAsin: diagnosticStatusesByAsin(asins, invocationDiagnostics) };
      };
      const commandEnv = jobProviderEnvironment(jobId, stage, repairProviderEnvironment(initialJob, stage, dispatch.env));
      if (streamingScript) {
        const deadline = Number(commandEnv.SORFTIME_COLLECTION_DEADLINE);
        return runSorftimeCommand({ args: [path.join(root, "scripts", streamingScript)], asins,
          env: { ...process.env, ...commandEnv }, cwd: root,
          timeoutMs: Math.max(1, deadline - Date.now()) + 5_000,
          onProgress: value => patchSyncJob(jobId, { message: `Sorftime ${value.asin} · 已处理 ${value.completed}/${value.total} 个子体${value.state === "partial" ? " · 可选详情部分未取得" : ""}` }),
          onHeartbeat: elapsed => patchSyncJob(jobId, { message: `Sorftime ${label} · 已用时 ${elapsed} 秒 · 采集预算内等待响应` }),
        }).then(finish);
      }
      return finish(tryRunProviderCommand(label, command, args, commandEnv));
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

export function createSorftimeVariantInvocation(asins, marketplace) {
  return Object.freeze({
    connector: "sorftime",
    stage: "child_sales",
    asins,
    label: "variant:sorftime:sync",
    command: "npm",
    args: ["run", "variant:sorftime:sync"],
    env: {
      SORFTIME_ASINS: asins.join(","),
      SORFTIME_MARKETPLACE: marketplace,
    },
  });
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
  readCatalogProducts = () => readAsinStatusSources().catalogProducts ?? [],
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

  const catalogProducts = readCatalogProducts();
  const oldFallbackAsins = catalogPending.filter(asin => catalogProducts.some(product =>
    product.asin === asin && product.catalogSource === "sorftime-fallback"));
  const profileUpgrades = asinsNeedingSorftimeCatalogSync(oldFallbackAsins, { catalogProducts, marketplace });
  const stillMissing = [...new Set([...asinsNeedingCatalog(catalogPending), ...profileUpgrades])];
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

export function runCatalogPhase({
  jobId,
  job,
  asins,
  marketplace,
  catalogPending,
  catalogProviderPlan,
  providers,
  shouldRun = shouldRunSyncStage,
  activate = activateStage,
  patch = patchSyncJob,
  runCatalog = runCatalogStage,
  finalizeCached = finalizeCachedStage,
  apply = (asin, commandSucceeded) => applyPersistedStagePostcondition(jobId, "catalog", [asin], { commandSucceeded }),
  runXydc = runOptionalXydcVariantEnrichment,
  captureCatalog = captureCatalogForSyncJob,
}) {
  if (shouldRun(job, "catalog") && catalogPending.length) {
    activate(jobId, "catalog");
    patch(jobId, { message: `卖家精灵底库入库 · ${catalogPending.length} 个 ASIN` });
    runCatalog({ asins, catalogPending, marketplace, catalogProviderPlan, providers, apply });
  } else if (shouldRun(job, "catalog")) {
    finalizeCached(jobId, "catalog", asins);
  }
  try {
    patch(jobId, { catalogCapture: captureCatalog(asins) });
  } catch {
    patch(jobId, { catalogCapture: null });
  }
  const catalogStage = job?.stages?.find(stage => stage.id === "catalog");
  const xydcAsins = Array.isArray(catalogStage?.repairAsins)
    ? asins.filter(asin => (catalogStage.repairXydcAsins ?? []).includes(asin))
    : asins;
  return xydcAsins.length ? runXydc({ asins: xydcAsins, marketplace,
    ...(Array.isArray(catalogStage?.repairAsins) ? { scopeAsins: asins } : {}),
  }) : undefined;
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
  const catalogSources = readAsinStatusSources();
  const existingFallbackAsins = asins.filter(asin => catalogSources.catalogProducts?.some(product =>
    product.asin === asin && product.catalogSource === "sorftime-fallback"));
  const catalogCandidates = [...new Set([...asinsNeedingCatalogSync(asins, {
    retryFallback: catalogProviderPlan?.preferredConnectorId !== "sorftime",
    sources: catalogSources,
  }), ...asinsNeedingSorftimeCatalogSync(existingFallbackAsins, {
    catalogProducts: catalogSources.catalogProducts, marketplace,
  })])];
  const catalogPending = asinsForSyncStage(job, "catalog", catalogCandidates, asins);
  const providers = createJobProviderController(jobId, job);

  try {
    finalizeRepairCachedStages(jobId, job);
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

    const xydcResult = await runCatalogPhase({
      jobId,
      job,
      asins,
      marketplace,
      catalogPending,
      catalogProviderPlan,
      providers,
    });
    for (const asin of job.stages.find(stage => stage.id === "catalog")?.repairXydcAsins ?? []) {
      markAsinModule(jobId, asin, "xydc_orders", {
        status: xydcResult?.repairStatuses?.[asin] ?? "connector-failed",
        reason: xydcResult?.repairStatuses?.[asin] === "ready" ? null : xydcRepairReason(xydcResult, asin),
      });
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
        const keywordDiagnostics = [
          ...keywordsResult.diagnostics,
          ...sifKeywordSchemaDiagnostics(
            keywordAsins,
            readCachedDataExport(generatedAppDataPath(root, "sif-keyword-analysis-data.ts"), "sifKeywordAnalysisData"),
          ),
        ];
        finalizeProcessedStageCohort(jobId, "keywords", keywordAsins, asins, {
          initialJob: job,
          commandSucceeded: keywordsResult.succeeded,
          resultStatusesByAsin: diagnosticStatusesByAsin(keywordAsins, keywordDiagnostics),
          diagnostics: keywordDiagnostics,
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
          diagnostics: reviewDiagnostics,
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
          diagnostics: salesResult.diagnostics,
        });
      }

      const childAsins = stageAsins("child_sales");
      if (shouldRunSyncStage(job, "child_sales") && childAsins.length) {
        activateStage(jobId, "child_sales");
        patchSyncJob(jobId, { message: `Sorftime 变体评论结构 + 近30天子体销量 · ${mcpAsins.length} 个 ASIN` });
        const collectionDeadline = Date.now() + 180_000;
        const variantInvocation = createSorftimeVariantInvocation(childAsins, marketplace);
        const variantResult = await providers.run({ ...variantInvocation,
          streamingScript: "build-sorftime-variant-data.mjs",
          env: { ...variantInvocation.env, SORFTIME_COLLECTION_DEADLINE: String(Math.min(collectionDeadline, Date.now()+90_000)) },
        });
        const childSalesResult = await providers.run({
          connector: "sorftime", stage: "child_sales", asins: childAsins,
          label: "child-sales:sync", command: "npm", args: ["run", "child-sales:sync"],
          streamingScript: "build-sorftime-child-sales.mjs",
          env: { SORFTIME_ASINS: childAsins.join(","), SORFTIME_MARKETPLACE: marketplace, SORFTIME_COLLECTION_DEADLINE: String(collectionDeadline) },
          allowScopedEvidenceFallback: true,
        });
        const childDiagnostics = childSalesResult.succeeded
          ? childSalesResult.diagnostics
          : [...variantResult.diagnostics, ...childSalesResult.diagnostics];
        const childOutcomes = childSalesResultStatuses(readCachedDataExport(
          generatedAppDataPath(root, 'sorftime-child-sales-data.ts'), 'sorftimeChildSalesOutcomeByAsin'),
          childAsins, { jobId, marketplace });
        finalizeProcessedStageCohort(jobId, "child_sales", childAsins, asins, {
          initialJob: job,
          commandSucceeded: childSalesResult.succeeded,
          resultStatusesByAsin: { ...diagnosticStatusesByAsin(childAsins, childDiagnostics), ...childOutcomes.statuses },
          resultReasonsByAsin: childOutcomes.reasons,
          diagnostics: childDiagnostics,
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
        finalizeProcessedStageCohort(jobId, "price_strategy", priceAsins, asins, {
          initialJob: job,
          commandSucceeded: priceResult.succeeded,
          resultStatusesByAsin: priceResult.statusesByAsin,
          diagnostics: priceResult.diagnostics,
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
          diagnostics: fbaResult.diagnostics,
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
        diagnostics: listingResult.diagnostics,
      });
    } else if (shouldRunSyncStage(job, "listing")) {
      finalizeCachedStage(jobId, "listing", asins);
    }

    const explicitImageStage = job.stages.find(stage => stage.id === "image_remarks");
    const currentImageJob = readSyncJob(jobId);
    const refreshFailures = explicitImageStage?.imageAction === "refresh"
      ? (explicitImageStage.repairAsins ?? []).filter(asin => currentImageJob?.asinProgress?.[asin]?.listing?.status !== "ready")
      : [];
    if (refreshFailures.length) {
      finalizeProcessedStageCohort(jobId, "image_remarks", refreshFailures, asins, {
        initialJob: job,
        commandSucceeded: false,
        imageRemarksData: { remarksByAsin: {}, outcomesByAsin: {} },
        readReadiness: (_stage, cohort) => ({
          stageId: "image_remarks", ready: false,
          items: cohort.map(asin => ({ asin, imageRemarks: "missing" })),
          missingAsins: cohort,
        }),
        resultStatusesByAsin: Object.fromEntries(refreshFailures.map(asin => [asin, "connector-failed"])),
        unavailableReason: "本次图片抓取失败，未重新分析，保留原图和分析结果",
      });
    }
    const reactivatedImageAsins = reactivateImageRemarksForReadyGalleries(jobId,
      explicitImageStage?.imageAction ? (explicitImageStage.repairAsins ?? []).filter(asin => !refreshFailures.includes(asin)) : asins);

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
        diagnostics: categoryResult.diagnostics,
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
          diagnostics: trafficResult.diagnostics,
        });
      }
    } else if (shouldRunSyncStage(job, "traffic")) {
      finalizeCachedStage(jobId, "traffic", asins);
    }

    const imageStageJob = readSyncJob(jobId);
    const imageSchedule = imageRemarkScheduling(job, imageStageJob, asins, reactivatedImageAsins.length > 0);
    const imageAsins = imageSchedule.analysisAsins;
    if (imageSchedule.shouldRun) {
      activateStage(jobId, "image_remarks");
      setStage(jobId, "image_remarks", {
        status: "active",
        detail: "图片 AI 备注：等待处理（并发 4，单图最长 120 秒）",
      });
      patchSyncJob(jobId, { message: "正在自动生成图片 AI 备注…" });
      let latestImageStageDetail = null;
      const persistedImageJob = readSyncJob(jobId);
      let imageListingInputDir;
      let imageListingInputFile;
      let imageCandidateFile;
      let imageListingByAsin;
      let galleryReadyAsins = imageAsins;
      let imageCaptureCohort = imageAsins;
      let missingGalleryAsins = [];
      if (persistedImageJob?.scope?.organizationId) {
        // Verify provenance before handing the captured gallery to the image subprocess.
        const partition = partitionImageListingInput(persistedImageJob, asins);
        imageCaptureCohort = asins;
        imageListingByAsin = partition.listingByAsin;
        galleryReadyAsins = partition.readyAsins;
        missingGalleryAsins = partition.missingAsins;
        const { dataRoot } = resolveRuntimeRoots({
          codeRoot: root, formal: Boolean(process.env.AGENT_FORMAL_WORKTREE_ROOT), env: process.env,
        });
        const candidateRoot = path.join(dataRoot, "sync-image-candidates");
        fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
        imageListingInputDir = fs.mkdtempSync(path.join(candidateRoot, `image-${process.pid}-`));
        imageListingInputFile = path.join(imageListingInputDir, "listing.json");
        imageCandidateFile = path.join(imageListingInputDir, "image-candidate.json");
        fs.writeFileSync(imageListingInputFile, JSON.stringify({ jobId, job: persistedImageJob }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      let imageProcess;
      let imageStagePersisted = false;
      try {
        const dispatchImageProcess = async (readyAsins) => runImageRemarkProcess({
        command: "npm",
        args: ["run", "image-remarks:sync"],
        cwd: root,
        env: repairProviderEnvironment(job, "image_remarks", {
          ...process.env,
          REMARK_ASINS: readyAsins.join(","),
          AGENT_SYNC_JOB_ID: jobId,
          AGENT_SYNC_STAGE_ID: "image_remarks",
          ...(imageListingInputFile ? { AGENT_SYNC_LISTING_STAGE_FILE: imageListingInputFile } : {}),
          ...(imageCandidateFile ? {
            AGENT_SYNC_IMAGE_CANDIDATE_FILE: imageCandidateFile,
            AGENT_SYNC_IMAGE_CAPTURE_ASINS: galleryReadyAsins.join(","),
            AGENT_SYNC_LISTING_STAGE_HASH: persistedImageJob.outputs.find(output => output.stage === "listing").contentHash,
          } : {}),
          AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "1",
        }),
        onProgress: (event) => {
          latestImageStageDetail = formatImageRemarkStageDetail(event);
          setStage(jobId, "image_remarks", {
            status: "active",
            detail: latestImageStageDetail,
          });
        },
        onOutput: text => process.stdout.write(sanitizeCommandOutput(text)),
        });
        imageProcess = persistedImageJob?.scope?.organizationId
          ? (await runGalleryReadyImageProcess(persistedImageJob, asins, ready => dispatchImageProcess(ready.filter(asin => imageAsins.includes(asin))))).process
          : await dispatchImageProcess(imageAsins);
        let imageRemarksData = { remarksByAsin: {}, outcomesByAsin: {} };
        if (imageCandidateFile && fs.existsSync(imageCandidateFile)) {
          imageRemarksData = readImageRemarkCandidate(imageCandidateFile, { job: persistedImageJob, asins: galleryReadyAsins });
        } else if (imageCandidateFile && galleryReadyAsins.length && imageProcess.succeeded) {
          throw new Error("Successful image worker did not persist its job candidate");
        }
        const scopedImageStatuses = imageCandidateFile
          ? imageCandidateResultStatuses(imageRemarksData, imageListingByAsin, imageCaptureCohort)
          : readImageRemarkStatuses();
        for (const asin of missingGalleryAsins) {
          const previousFailure = persistedImageJob?.asinProgress?.[asin]?.image_remarks?.status;
          if (["connector-failed", "timeout"].includes(previousFailure)) scopedImageStatuses[asin] = previousFailure;
        }
        finalizeProcessedStageCohort(jobId, "image_remarks", imageCaptureCohort, asins, {
          initialJob: job,
          commandSucceeded: imageProcess.succeeded,
          ...(imageCandidateFile ? {
            imageRemarksData,
            readReadiness: (_stage, cohort) => imageCandidateReadiness(imageRemarksData, imageListingByAsin, cohort),
          } : {}),
          resultStatusesByAsin: scopedImageStatuses,
          resultReasonsByAsin: Object.fromEntries(missingGalleryAsins.map(asin =>
            [asin, "本次任务缺少可用图库，未调用图片模型"])),
          unavailableReason: missingGalleryAsins.length
            ? `本次任务缺少可用图库，未分析 ${missingGalleryAsins.length} 个 ASIN`
            : imageProcess.succeeded ? null : "图片 AI 备注存在明确缺口",
          stageDetail: latestImageStageDetail,
        });
        if (imageCandidateFile) {
          const committedJob = readSyncJob(jobId);
          const committedOutput = committedJob?.outputs?.find(output => output.stage === "image_remarks");
          validatePersistedImageStageOutput(committedJob, committedOutput);
          imageStagePersisted = true;
        }
      } finally {
        if (imageListingInputDir && imageStagePersisted) {
          fs.rmSync(imageListingInputDir, { recursive: true, force: true });
        }
      }
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
