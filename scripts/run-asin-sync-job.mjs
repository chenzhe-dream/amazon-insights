import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  asinsNeedingMcpSync,
  asinsNeedingCatalogSync,
  asinsNeedingTrafficSync,
  asinsNeedingListingSync,
  asinsNeedingImageRemarksSync,
  estimateAlexaVocSeconds,
  getAsinDataStatus,
  hasImageRemarks,
} from "./lib/asin-data-status.mjs";
import {
  markAsinModule,
  patchSyncJob,
  readSyncJob,
  setStage,
} from "./lib/sync-job-store.mjs";
import { hasOpenAiKey, loadLocalEnv } from "./lib/local-env.mjs";

loadLocalEnv();

const root = path.resolve(import.meta.dirname, "..");
const amazonAuthFile = path.join(root, "data", "amazon-auth.json");

function shouldAutoAlexaVoc() {
  if (process.env.ALEXA_AUTO === "0") return false;
  if (process.env.ALEXA_CDP_URL?.trim()) return true;
  return fs.existsSync(amazonAuthFile);
}

function runCommand(label, command, args, env = {}) {
  console.log(`[job] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
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
  getAsinDataStatus(asins).forEach(item => {
    markAsinModule(jobId, item.asin, "voc", item.voc === "ready" ? "ready" : "awaiting_manual");
  });
}

function setAlexaManualStage(jobId, asins, vocPending, alexaDeadline) {
  patchSyncJob(jobId, {
    message:
      vocPending.length > 0
        ? `${vocPending.length} 个 ASIN 的 Alexa VOC 待录入`
        : "VOC 核心主题已全部录入",
    alexaVoc: {
      pendingAsins: vocPending.map(item => item.asin),
      estimatedSeconds: estimateAlexaVocSeconds(vocPending.length, { auto: false }),
      deadlineAt: alexaDeadline,
    },
  });
  markVocProgress(jobId, asins);
  if (vocPending.length === 0) {
    completeStage(jobId, "alexa_voc");
    return;
  }
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
  job.status = "running";
  patchSyncJob(jobId, job);
}

function completeStage(jobId, stageId) {
  const now = new Date().toISOString();
  setStage(jobId, stageId, { status: "done", completedAt: now });
}

function failJob(jobId, message) {
  patchSyncJob(jobId, { status: "failed", message });
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
    { cwd: root, detached: true, stdio: "ignore", shell: true }
  );
  child.unref();
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: node scripts/run-asin-sync-job.mjs <jobId>");
    process.exit(1);
  }

  const job = readSyncJob(jobId);
  if (!job) {
    console.error(`[error] job not found: ${jobId}`);
    process.exit(1);
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

    if (catalogPending.length) {
      activateStage(jobId, "catalog");
      patchSyncJob(jobId, { message: `卖家精灵底库入库 · ${catalogPending.length} 个 ASIN` });
      runCommand("catalog:sync", "npm", ["run", "catalog:sync"], {
        SELLERSPRITE_ASINS: catalogPending.join(","),
        SELLERSPRITE_MARKETPLACE: marketplace,
      });
      completeStage(jobId, "catalog");
    } else {
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
      mcpAsins.forEach(asin => markAsinModule(jobId, asin, "keywords", "ready"));
      completeStage(jobId, "keywords");

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
      mcpAsins.forEach(asin => markAsinModule(jobId, asin, "reviews", "ready"));
      completeStage(jobId, "reviews");

      activateStage(jobId, "sales_trend");
      patchSyncJob(jobId, { message: `Sorftime 销量趋势 · ${mcpAsins.length} 个 ASIN` });
      runCommand("sales:sync", "npm", ["run", "sales:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      completeStage(jobId, "sales_trend");

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
      completeStage(jobId, "child_sales");

      activateStage(jobId, "price_strategy");
      patchSyncJob(jobId, { message: `Sorftime 价格策略 · ${mcpAsins.length} 个 ASIN` });
      runCommand("price-strategy:sync", "npm", ["run", "price-strategy:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      completeStage(jobId, "price_strategy");

      activateStage(jobId, "fba");
      patchSyncJob(jobId, { message: `Sorftime FBA 费用 · ${mcpAsins.length} 个 ASIN` });
      runCommand("fba:sync", "npm", ["run", "fba:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      completeStage(jobId, "fba");

      activateStage(jobId, "category");
      patchSyncJob(jobId, { message: `Sorftime BSR 小类趋势 · ${mcpAsins.length} 个 ASIN` });
      runCommand("category:sync", "npm", ["run", "category:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      mcpAsins.forEach(asin => markAsinModule(jobId, asin, "sales", "ready"));
      completeStage(jobId, "category");
    } else {
      [
        "catalog",
        "keywords",
        "reviews",
        "sales_trend",
        "child_sales",
        "price_strategy",
        "fba",
        "category",
      ].forEach(stageId => {
        setStage(jobId, stageId, { status: "skipped", completedAt: new Date().toISOString() });
      });
    }

    const vocPending = getAsinDataStatus(asins).filter(item => item.voc === "missing");
    const listingPending = asinsNeedingListingSync(asins);
    const trafficPending = asinsNeedingTrafficSync(asins);
    const alexaDeadline = new Date(
      Date.now() + estimateAlexaVocSeconds(vocPending.length, { auto: shouldAutoAlexaVoc() })
    ).toISOString();

    activateStage(jobId, "alexa_voc");
    if (vocPending.length === 0) {
      patchSyncJob(jobId, { message: "VOC 核心主题已全部录入" });
      completeStage(jobId, "alexa_voc");
    } else if (shouldAutoAlexaVoc()) {
      patchSyncJob(jobId, {
        message: `Alexa VOC 自动抓取 · ${vocPending.length} 个 ASIN`,
      });
      const autoOk = tryRunCommand("alexa:sync", "npm", ["run", "alexa:sync"], {
        ALEXA_ASINS: vocPending.map(item => item.asin).join(","),
        ALEXA_HEADLESS: process.env.ALEXA_HEADLESS ?? "1",
        ALEXA_MARKETPLACE: marketplace,
      });
      markVocProgress(jobId, asins);
      const vocStillPending = getAsinDataStatus(asins).filter(item => item.voc === "missing");
      if (autoOk && vocStillPending.length === 0) {
        completeStage(jobId, "alexa_voc");
      } else {
        setAlexaManualStage(jobId, asins, vocStillPending, alexaDeadline);
      }
    } else {
      console.log("[job] skip Alexa auto · run npm run alexa:login to enable Playwright capture");
      setAlexaManualStage(jobId, asins, vocPending, alexaDeadline);
    }

    if (listingPending.length) {
      activateStage(jobId, "listing");
      patchSyncJob(jobId, { message: `Sorftime Listing 主辅图 / A+ · ${listingPending.length} 个 ASIN` });
      runCommand("listing:sync", "npm", ["run", "listing:sync"], {
        SORFTIME_ASINS: listingPending.map(item => item.asin).join(","),
        SORFTIME_MARKETPLACE: marketplace,
      });
      listingPending.forEach(item => markAsinModule(jobId, item.asin, "listing", "ready"));
      completeStage(jobId, "listing");
    } else {
      setStage(jobId, "listing", { status: "skipped", completedAt: new Date().toISOString() });
    }

    const imageRemarksPending = asinsNeedingImageRemarksSync(asins);
    if (imageRemarksPending.length) {
      activateStage(jobId, "image_remarks");
      const openaiReady = hasOpenAiKey();
      patchSyncJob(jobId, {
        message: openaiReady
          ? `主辅图视觉备注 · ${imageRemarksPending.length} 个 ASIN · ecommerce-product-image-analysis`
          : `主辅图视觉备注无法生成：未配置 OPENAI_API_KEY（${imageRemarksPending.length} 个 ASIN 将显示「待分析」）`,
      });
      tryRunCommand("image-remarks:sync", "npm", ["run", "image-remarks:sync"], {
        REMARK_ASINS: imageRemarksPending.map(item => item.asin).join(","),
      });
      imageRemarksPending.forEach(item => {
        markAsinModule(jobId, item.asin, "imageRemarks", hasImageRemarks(item.asin) ? "ready" : "missing");
      });
      const stillMissing = asinsNeedingImageRemarksSync(asins);
      if (stillMissing.length) {
        setStage(jobId, "image_remarks", {
          status: openaiReady ? "failed" : "skipped",
          detail: openaiReady
            ? `${stillMissing.length} 个 ASIN 视觉备注未完成，页面仍显示「待分析」`
            : "未配置 OPENAI_API_KEY（.env / .env.local / data/openai-api-key.txt），图册已拉回但视觉备注不会生成",
          completedAt: new Date().toISOString(),
        });
      } else {
        completeStage(jobId, "image_remarks");
      }
    } else {
      setStage(jobId, "image_remarks", { status: "skipped", completedAt: new Date().toISOString() });
    }

    if (trafficPending.length) {
      activateStage(jobId, "traffic");
      patchSyncJob(jobId, { message: `SIF 竞品流量结构 · ${trafficPending.length} 个 ASIN` });
      runCommand("traffic:sync", "npm", ["run", "traffic:sync"], {
        SIF_ASINS: trafficPending.map(item => item.asin).join(","),
        SIF_MARKETPLACE: marketplace,
      });
      trafficPending.forEach(item => markAsinModule(jobId, item.asin, "traffic", "ready"));
      completeStage(jobId, "traffic");
    } else {
      setStage(jobId, "traffic", { status: "skipped", completedAt: new Date().toISOString() });
    }

    activateStage(jobId, "build");
    patchSyncJob(jobId, { message: "正在构建前端包并重启团队服务…" });
    runCommand("build", "npm", ["run", "build"]);
    completeStage(jobId, "build");

    await restartTeamServer();

    const vocStillPending = getAsinDataStatus(asins).filter(item => item.voc === "missing");
    patchSyncJob(jobId, {
      status: "completed",
      message:
        vocStillPending.length > 0
          ? `同步完成。${vocStillPending.length} 个 ASIN 的 Alexa VOC 仍待录入（运行 npm run alexa:login 后重试同步）。`
          : "全部数据同步完成，页面即将刷新。",
      completedAt: new Date().toISOString(),
      needsReload: true,
    });
    console.log(`[done] job ${jobId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    failJob(jobId, message);
    process.exit(1);
  }
}

main();
