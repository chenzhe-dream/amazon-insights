import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASIN_SYNC_STAGE_IDS,
  asinsNeedingMcpSync,
  asinsNeedingCatalogSync,
  asinsNeedingTrafficSync,
  asinsNeedingListingSync,
  asinsNeedingImageRemarksSync,
  evaluateAsinStageReadiness,
  estimateAlexaVocSeconds,
  getAsinDataStatus,
  isAsinStageReady,
  readAsinStageReadiness,
} from "./lib/asin-data-status.mjs";
import {
  aggregateAsinModuleStatuses,
  deriveFinalSyncJobStatus,
  failSyncJob,
  markSyncJobBaseReady,
  markSyncJobEnriching,
  markAsinModule,
  patchSyncJob,
  readSyncJob,
  setStage,
} from "./lib/sync-job-store.mjs";
import { hasOpenAiKey, loadLocalEnv } from "./lib/local-env.mjs";
import {
  shouldBuildAndRestartForSync,
  windowsHiddenChildProcessOptions,
} from "./lib/sync-runtime-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const amazonAuthFile = path.join(root, "data", "amazon-auth.json");

export const BASE_COHORT_STAGE_IDS = [
  "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
  "fba", "listing", "category", "traffic",
];
const TERMINAL_ASIN_STATUSES = new Set(["ready", "upstream-empty", "timeout", "connector-failed", "manual"]);

export function trafficIsTerminalBeforeImageRemarks(progress) {
  const traffic = progress?.traffic?.status ?? progress?.traffic;
  const imageRemarks = progress?.image_remarks?.status ?? progress?.image_remarks;
  return TERMINAL_ASIN_STATUSES.has(traffic) && imageRemarks === "pending";
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
  if (result.error || result.status !== 0) {
    throw new Error(formatCommandFailure(label, result, commandEnv));
  }
}

function tryRunCommand(label, command, args, env = {}) {
  try {
    runCommand(label, command, args, env);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[warn] ${message}`);
    return false;
  }
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
  const job = readSyncJob(jobId);
  if (!job) return;
  const now = new Date().toISOString();
  job.stages = job.stages.map(stage => {
    if (stage.id === stageId) return { ...stage, status: "active", startedAt: stage.startedAt ?? now };
    if (stage.status === "active") return { ...stage, status: "done", completedAt: now };
    return stage;
  });
  job.currentStageId = stageId;
  if (!["base-ready", "enriching"].includes(job.status)) job.status = "running";
  patchSyncJob(jobId, job);
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
    readReadiness = readAsinStageReadiness,
    markModule = markAsinModule,
    updateStage = setStage,
    now = () => new Date().toISOString(),
  } = {},
) {
  const readiness = markPersistedStageProgress(jobId, stageId, asins, { readReadiness, markModule });

  const completedAt = now();
  if (!commandSucceeded) {
    for (const missingAsin of readiness.missingAsins) {
      markModule(jobId, missingAsin, stageId, {
        status: "connector-failed",
        reason: unavailableReason ?? "连接器未完成该 ASIN",
      });
    }
  }
  const statuses = readiness.items.map(item => {
    if (isAsinStageReady(item, stageId)) return "ready";
    return commandSucceeded ? "upstream-empty" : "connector-failed";
  });
  const status = commandSucceeded && !readiness.missingAsins.length
    ? "done"
    : (commandSucceeded ? aggregateAsinModuleStatuses(statuses) : "partial");
  updateStage(jobId, stageId, {
    status,
    detail: readiness.missingAsins.length
      ? (unavailableReason ?? `${readiness.missingAsins.length}/${asins.length} 个 ASIN 的 ${stageId} 未返回可用数据`)
      : (commandSucceeded ? undefined : `${stageId} 连接器未完成`),
    completedAt,
  });
  return { status, missingAsins: readiness.missingAsins };
}

async function restartTeamServer() {
  const script = path.join(root, "scripts", "start-team-server.ps1");
  if (!fs.existsSync(script)) {
    console.log("[job] skip server restart · start-team-server.ps1 not found");
    return;
  }
  console.log("[job] restarting team server (SkipBuild)...");
  const child = spawn(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", script, "-SkipBuild"],
    {
      cwd: root,
      detached: true,
      stdio: "ignore",
      shell: true,
      ...windowsHiddenChildProcessOptions(),
    }
  );
  child.unref();
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

  const { asins, marketplace } = job;
  const catalogPending = asinsNeedingCatalogSync(asins);

  try {
    activateStage(jobId, "queue");
    patchSyncJob(jobId, {
      message: catalogPending.length
        ? `准备同步 ${asins.length} 个 ASIN（${catalogPending.length} 个待入库底库）`
        : `准备同步 ${asins.length} 个 ASIN 的 MCP 数据`,
    });
    completeStage(jobId, "queue");
    setAlexaManualStage(jobId, asins, asins.map(asin => ({ asin })), new Date().toISOString());

    if (catalogPending.length) {
      activateStage(jobId, "catalog");
      patchSyncJob(jobId, { message: `卖家精灵底库入库 · ${catalogPending.length} 个 ASIN` });
      runCommand("catalog:sync", "npm", ["run", "catalog:sync"], {
        SELLERSPRITE_ASINS: catalogPending.join(","),
        SELLERSPRITE_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "catalog", catalogPending);
    } else {
      markPersistedStageProgress(jobId, "catalog", asins);
      setStage(jobId, "catalog", { status: "skipped", completedAt: new Date().toISOString() });
    }

    const needing = asinsNeedingMcpSync(asins);
    const mcpAsins = needing.map(item => item.asin);
    const asinEnv = mcpAsins.join(",");

    if (mcpAsins.length) {
      activateStage(jobId, "keywords");
      patchSyncJob(jobId, { message: `SIF 关键词 MCP · ${mcpAsins.length} 个 ASIN` });
      runCommand("keywords:sync", "npm", ["run", "keywords:sync"], {
        SIF_ASINS: asinEnv,
        SIF_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "keywords", mcpAsins);

      activateStage(jobId, "reviews");
      patchSyncJob(jobId, { message: `Sorftime 评分 / 评论 + 评论分析 · ${mcpAsins.length} 个 ASIN` });
      runCommand("rating:sync", "npm", ["run", "rating:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      runCommand("review:sync", "npm", ["run", "review:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "reviews", mcpAsins);

      activateStage(jobId, "sales_trend");
      patchSyncJob(jobId, { message: `Sorftime 销量趋势 · ${mcpAsins.length} 个 ASIN` });
      runCommand("sales:sync", "npm", ["run", "sales:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "sales_trend", mcpAsins);

      activateStage(jobId, "child_sales");
      patchSyncJob(jobId, { message: `Sorftime 变体评论结构 + 近30天子体销量 · ${mcpAsins.length} 个 ASIN` });
      runCommand("variant:sync", "npm", ["run", "variant:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      runCommand("child-sales:sync", "npm", ["run", "child-sales:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "child_sales", mcpAsins);

      activateStage(jobId, "price_strategy");
      patchSyncJob(jobId, { message: `Sorftime 价格策略 · ${mcpAsins.length} 个 ASIN` });
      runCommand("price-strategy:sync", "npm", ["run", "price-strategy:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "price_strategy", mcpAsins);

      activateStage(jobId, "fba");
      patchSyncJob(jobId, { message: `Sorftime FBA 费用 · ${mcpAsins.length} 个 ASIN` });
      runCommand("fba:sync", "npm", ["run", "fba:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "fba", mcpAsins);

    } else {
      [
        "keywords",
        "reviews",
        "sales_trend",
        "child_sales",
        "price_strategy",
        "fba",
      ].forEach(stageId => {
        markPersistedStageProgress(jobId, stageId, asins);
        setStage(jobId, stageId, { status: "skipped", completedAt: new Date().toISOString() });
      });
    }

    const listingPending = asinsNeedingListingSync(asins);
    const trafficPending = asinsNeedingTrafficSync(asins);

    if (listingPending.length) {
      activateStage(jobId, "listing");
      patchSyncJob(jobId, { message: `Sorftime Listing 主辅图 / A+ · ${listingPending.length} 个 ASIN` });
      runCommand("listing:sync", "npm", ["run", "listing:sync"], {
        SORFTIME_ASINS: listingPending.map(item => item.asin).join(","),
        SORFTIME_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "listing", listingPending.map(item => item.asin));
    } else {
      markPersistedStageProgress(jobId, "listing", asins);
      setStage(jobId, "listing", { status: "skipped", completedAt: new Date().toISOString() });
    }

    if (mcpAsins.length) {
      activateStage(jobId, "category");
      patchSyncJob(jobId, { message: `Sorftime BSR 小类趋势 · ${mcpAsins.length} 个 ASIN` });
      const commandSucceeded = tryRunCommand("category:sync", "npm", ["run", "category:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "category", mcpAsins, { commandSucceeded });
    } else {
      markPersistedStageProgress(jobId, "category", asins);
      setStage(jobId, "category", { status: "skipped", completedAt: new Date().toISOString() });
    }

    if (trafficPending.length) {
      activateStage(jobId, "traffic");
      patchSyncJob(jobId, { message: `SIF 竞品流量结构 · ${trafficPending.length} 个 ASIN` });
      runCommand("traffic:sync", "npm", ["run", "traffic:sync"], {
        SIF_ASINS: trafficPending.map(item => item.asin).join(","),
        SIF_MARKETPLACE: marketplace,
      });
      applyPersistedStagePostcondition(jobId, "traffic", trafficPending.map(item => item.asin));
    } else {
      markPersistedStageProgress(jobId, "traffic", asins);
      setStage(jobId, "traffic", { status: "skipped", completedAt: new Date().toISOString() });
    }

    markSyncJobBaseReady(jobId);

    if (shouldBuildAndRestartForSync(process.env)) {
      activateStage(jobId, "build");
      patchSyncJob(jobId, { message: "正在构建前端包并重启团队服务…" });
      runCommand("build", "npm", ["run", "build"]);
      completeStage(jobId, "build");

      await restartTeamServer();
    } else {
      setStage(jobId, "build", {
        status: "skipped",
        detail: "本机 fake 模式跳过前端构建与团队服务重启。",
        completedAt: new Date().toISOString(),
      });
    }

    markSyncJobEnriching(jobId);
    const imageRemarksPending = asinsNeedingImageRemarksSync(asins);
    if (imageRemarksPending.length) {
      activateStage(jobId, "image_remarks");
      const openaiReady = hasOpenAiKey();
      patchSyncJob(jobId, {
        message: openaiReady
          ? `主辅图视觉备注 · ${imageRemarksPending.length} 个 ASIN · ecommerce-product-image-analysis`
          : `主辅图视觉备注无法生成：未配置图像分析凭据（${imageRemarksPending.length} 个 ASIN 将显示「待分析」）`,
      });
      const commandSucceeded = tryRunCommand("image-remarks:sync", "npm", ["run", "image-remarks:sync"], {
        REMARK_ASINS: imageRemarksPending.map(item => item.asin).join(","),
      });
      applyPersistedStagePostcondition(jobId, "image_remarks", imageRemarksPending.map(item => item.asin), {
        commandSucceeded,
        unavailableReason: openaiReady ? null : "图像分析未配置",
      });
    } else {
      markPersistedStageProgress(jobId, "image_remarks", asins);
      setStage(jobId, "image_remarks", { status: "skipped", completedAt: new Date().toISOString() });
    }

    const finalStatus = deriveFinalSyncJobStatus(readSyncJob(jobId)?.asinProgress) ?? "completed-with-gaps";
    patchSyncJob(jobId, {
      status: finalStatus,
      message: finalStatus === "completed"
        ? "基础数据与图片备注已完成。"
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
