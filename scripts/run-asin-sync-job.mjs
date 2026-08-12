import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  asinsNeedingMcpSync,
  estimateAlexaVocSeconds,
  getAsinDataStatus,
} from "./lib/asin-data-status.mjs";
import {
  markAsinModule,
  patchSyncJob,
  readSyncJob,
  setStage,
} from "./lib/sync-job-store.mjs";

const root = path.resolve(import.meta.dirname, "..");
const amazonAuthFile = path.join(root, "data", "amazon-auth.json");

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
  const needing = asinsNeedingMcpSync(asins);
  const mcpAsins = needing.map(item => item.asin);
  const asinEnv = mcpAsins.join(",");

  try {
    activateStage(jobId, "queue");
    patchSyncJob(jobId, {
      message: mcpAsins.length ? `准备同步 ${mcpAsins.length} 个 ASIN 的 MCP 数据` : "MCP 数据已齐全，跳过拉取",
    });
    completeStage(jobId, "queue");

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
      patchSyncJob(jobId, { message: `Sorftime 评论 MCP · ${mcpAsins.length} 个 ASIN` });
      runCommand("review:sync", "npm", ["run", "review:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      mcpAsins.forEach(asin => markAsinModule(jobId, asin, "reviews", "ready"));
      completeStage(jobId, "reviews");

      activateStage(jobId, "sales");
      patchSyncJob(jobId, { message: `Sorftime 销量 MCP · ${mcpAsins.length} 个 ASIN` });
      runCommand("sales:sync", "npm", ["run", "sales:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      patchSyncJob(jobId, { message: `Sorftime 近30天子体销量 · ${mcpAsins.length} 个 ASIN` });
      runCommand("child-sales:sync", "npm", ["run", "child-sales:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      patchSyncJob(jobId, { message: `Sorftime 价格策略 · ${mcpAsins.length} 个 ASIN` });
      runCommand("price-strategy:sync", "npm", ["run", "price-strategy:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      patchSyncJob(jobId, { message: `Sorftime FBA 费用 · ${mcpAsins.length} 个 ASIN` });
      runCommand("fba:sync", "npm", ["run", "fba:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      patchSyncJob(jobId, { message: `Sorftime Listing 主辅图 / A+ · ${mcpAsins.length} 个 ASIN` });
      runCommand("listing:sync", "npm", ["run", "listing:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      patchSyncJob(jobId, { message: `Sorftime BSR 小类趋势 · ${mcpAsins.length} 个 ASIN` });
      runCommand("category:sync", "npm", ["run", "category:sync"], {
        SORFTIME_ASINS: asinEnv,
        SORFTIME_MARKETPLACE: marketplace,
      });
      mcpAsins.forEach(asin => markAsinModule(jobId, asin, "sales", "ready"));
      completeStage(jobId, "sales");
    } else {
      ["keywords", "reviews", "sales"].forEach(stageId => {
        setStage(jobId, stageId, { status: "skipped", completedAt: new Date().toISOString() });
      });
    }

    const vocPending = getAsinDataStatus(asins).filter(item => item.voc === "missing");
    const alexaDeadline = new Date(Date.now() + estimateAlexaVocSeconds(vocPending.length)).toISOString();

    if (vocPending.length > 0 && process.env.ALEXA_AUTO === "1" && fs.existsSync(amazonAuthFile)) {
      activateStage(jobId, "alexa_voc");
      patchSyncJob(jobId, {
        message: `Alexa VOC 自动抓取 · ${vocPending.length} 个 ASIN`,
      });
      runCommand("alexa:sync", "npm", ["run", "alexa:sync"], {
        ALEXA_ASINS: vocPending.map(item => item.asin).join(","),
        ALEXA_HEADLESS: process.env.ALEXA_HEADLESS ?? "1",
      });
      vocPending.forEach(item => markAsinModule(jobId, item.asin, "voc", "ready"));
      completeStage(jobId, "alexa_voc");
    } else {
      activateStage(jobId, "alexa_voc");
      patchSyncJob(jobId, {
        message:
          vocPending.length > 0
            ? `${vocPending.length} 个 ASIN 待 Alexa 录入 VOC 核心主题（约 ${Math.ceil(estimateAlexaVocSeconds(vocPending.length) / 60)} 分钟）`
            : "VOC 核心主题已全部录入",
        alexaVoc: {
          pendingAsins: vocPending.map(item => item.asin),
          estimatedSeconds: estimateAlexaVocSeconds(vocPending.length),
          deadlineAt: alexaDeadline,
        },
      });
      vocPending.forEach(item => markAsinModule(jobId, item.asin, "voc", "awaiting_manual"));
      asins
        .filter(asin => !vocPending.some(item => item.asin === asin))
        .forEach(asin => markAsinModule(jobId, asin, "voc", "ready"));

      if (vocPending.length === 0) {
        completeStage(jobId, "alexa_voc");
      } else {
        setStage(jobId, "alexa_voc", {
          status: "manual",
          startedAt: new Date().toISOString(),
        });
      }
    }

    activateStage(jobId, "build");
    patchSyncJob(jobId, { message: "正在构建前端包并重启团队服务…" });
    runCommand("build", "npm", ["run", "build"]);
    completeStage(jobId, "build");

    await restartTeamServer();

    patchSyncJob(jobId, {
      status: "completed",
      message:
        vocPending.length > 0
          ? `MCP 同步完成。${vocPending.length} 个 ASIN 的 VOC 核心主题仍待 Alexa 手工录入。`
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
