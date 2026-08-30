import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createBuildSourceFingerprint } from "../../scripts/lib/build-fingerprint.mjs";

const asin = "B07VY9Q95Q";
const report = [
  `${asin} — 顾客洞察完整分析`,
  "1️⃣ 顾客关注点",
  "1. 安装简单且连接稳定",
  "2️⃣ 好评点",
  "质量可靠（好评维度10次提及，20%）",
  "3️⃣ 差评点",
  "包装有待改善（差评维度5次提及，10%）",
  "4️⃣ 未被满足的需求",
  "1. 希望增加更多配件",
  "5️⃣ 使用人群",
  "家庭用户｜需要稳定设备",
  "6️⃣ 使用场景",
  "户外使用｜日常活动",
  "7️⃣ 核心购买动机",
  "安全可靠｜减少维护",
  "总体结论：candidate runtime import seam",
].join("\n");

test("a built immutable candidate imports Alexa VOC only into the validated formal worktree", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-alexa-import-"));
  const candidateRoot = path.join(temporary, "data", "web-runtime-artifacts", "publication-test");
  const formalWorktree = path.join(temporary, "formal-worktree");
  const candidateServer = path.join(candidateRoot, "server");
  const originalFetch = globalThis.fetch;
  const savedEnvironment = {
    AGENT_FORMAL_WORKTREE_ROOT: process.env.AGENT_FORMAL_WORKTREE_ROOT,
    AGENT_SERVICE_INTERNAL_URL: process.env.AGENT_SERVICE_INTERNAL_URL,
    AGENT_SERVICE_PROXY_TOKEN: process.env.AGENT_SERVICE_PROXY_TOKEN,
  };
  try {
    const builtFingerprint = JSON.parse(await fs.readFile(path.resolve("dist", "build-fingerprint.json"), "utf8"));
    assert.equal(builtFingerprint.sourceHash, await createBuildSourceFingerprint(path.resolve(".")), "candidate dist must come from this exact source tree");
    await fs.cp(path.resolve("dist", "server"), candidateServer, { recursive: true });
    await fs.copyFile(path.resolve("dist", "build-fingerprint.json"), path.join(candidateRoot, "build-fingerprint.json"));
    await fs.writeFile(path.join(candidateRoot, "package.json"), '{"type":"module"}', "utf8");
    await fs.mkdir(path.join(formalWorktree, "app"), { recursive: true });
    await fs.mkdir(path.join(formalWorktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(formalWorktree, "package.json"), "{}", "utf8");
    await fs.copyFile(path.resolve("app", "rufus-voc-data.ts"), path.join(formalWorktree, "app", "rufus-voc-data.ts"));
    await fs.copyFile(path.resolve("app", "competitor-data.ts"), path.join(formalWorktree, "app", "competitor-data.ts"));
    await fs.writeFile(path.join(formalWorktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");

    process.env.AGENT_FORMAL_WORKTREE_ROOT = formalWorktree;
    process.env.AGENT_SERVICE_INTERNAL_URL = "http://agent.invalid";
    process.env.AGENT_SERVICE_PROXY_TOKEN = "candidate-test-token";
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "http://agent.invalid/v1/auth/session");
      return Response.json({
        authenticated: true,
        sessionIdentity: "A".repeat(43),
        user: {
          id: "10000000-0000-4000-8000-000000000001",
          organizationId: "10000000-0000-4000-8000-000000000002",
          email: "admin@example.com",
          displayName: "Admin",
          role: "admin",
          status: "active",
          createdAt: "2026-08-29T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:00.000Z",
        },
      });
    };

    const workerUrl = pathToFileURL(path.join(candidateServer, "index.js"));
    workerUrl.searchParams.set("candidate-test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "agent_session=opaque",
        origin: "http://127.0.0.1:31900",
      },
      body: JSON.stringify({ asin, text: report, autoRebuild: false }),
    }), {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    }, {
      waitUntil() {},
      passThroughOnException() {},
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(await fs.readFile(path.join(formalWorktree, "data", "alexa-voc-cache", `${asin}.txt`), "utf8"), report);
    const state = JSON.parse(await fs.readFile(path.join(formalWorktree, "data", "alexa-publication-state.json"), "utf8"));
    const snapshot = await fs.readFile(path.join(formalWorktree, "data", "alexa-publication-snapshots", state.snapshotFile), "utf8");
    assert.equal(state.generation, 1);
    assert.equal(state.dirty, true);
    assert.equal(state.sourceHash, createHash("sha256").update(snapshot).digest("hex"));
    assert.match(snapshot, /candidate runtime import seam/);
    await assert.rejects(fs.access(path.join(candidateRoot, "data")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(candidateRoot, "app")), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
