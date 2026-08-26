import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { readCachedDataExport } from "../../scripts/lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const generatorSource = fs.readFileSync(
  path.join(root, "scripts", "build-listing-image-remarks.mjs"),
  "utf8",
);

async function waitForCondition(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function startGenerator(fixtureRoot, fixtureScripts, asin, env = {}) {
  const child = spawn(process.execPath, [path.join(fixtureScripts, "build-listing-image-remarks.mjs")], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: "fixture-key",
      REMARK_ASINS: asin,
      AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk;
  });
  child.stderr.on("data", chunk => {
    output += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });
  return { child, closed };
}
test("generator emits a nullable slot type that matches inherited sparse remarks", () => {
  const nullableDeclaration = "Record<string, Array<ListingImageRemark | null>>";
  assert.match(generatorSource, new RegExp(nullableDeclaration.replace(/[|[\]().*+?{}\\]/g, "\\$&")));
  assert.match(generatorSource, /return listingImageRemarks\[asin\]\?\.\[slotIndex\] \?\? null;/);

  const fixtureRemarks = {
    inherited: [
      null,
      null,
      {
        remark: "Listing 视频位缩略图，非静态辅图分析范围。",
        image_types: ["其他"],
        confidence: "high",
      },
    ],
  };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-remarks-output-"));
  const fixturePath = path.join(tempRoot, "listing-image-remarks.ts");
  fs.writeFileSync(fixturePath, `export type ListingImageRemark = {
  remark: string;
  image_types: string[];
  confidence: "high" | "medium" | "low";
};
export const listingImageRemarks: ${nullableDeclaration} = ${JSON.stringify(fixtureRemarks, null, 2)};
export function getListingImageRemark(asin: string, slotIndex: number): ListingImageRemark | null {
  return listingImageRemarks[asin]?.[slotIndex] ?? null;
}
`, "utf8");

  try {
    const parsed = readCachedDataExport(fixturePath, "listingImageRemarks");
    assert.deepEqual(parsed.inherited.slice(0, 2), [null, null]);
    assert.equal(parsed.inherited[0] ?? null, null);
    assert.match(parsed.inherited[2]?.remark ?? "", /视频位缩略图/);

    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        fixturePath,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("image analysis prompt requires visible text before functional or scenario claims", () => {
  const prompt = generatorSource.match(/const SKILL_PROMPT = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.match(prompt, /可见文字明确/);
  assert.match(prompt, /不得声称防漏、无滴漏、耐用、安全/);
  assert.match(prompt, /不得推断使用场景或使用时机/);
  assert.match(prompt, /只描述可见结构、设计与呈现/);
});

test("generator emits sanitized per-image progress after queue settlement", () => {
  assert.match(
    generatorSource,
    /IMAGE_REMARK_PROGRESS[\s\S]*counts/,
  );
});

test("automatic generator relies on the one queue deadline instead of a shorter inner request timer", () => {
  assert.doesNotMatch(generatorSource, /imageRemarkRequestTimeoutMs/);
  assert.doesNotMatch(generatorSource, /fetchImageRemarkWithTimeout/);
  assert.match(generatorSource, /runImageRemarkQueue\(imageTasks/);
});

test("automatic image chat request omits relay-incompatible temperature", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-image-remarks-payload-"));
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureApp = path.join(fixtureRoot, "app");
  const asin = "B0PAYLOAD1";
  const imageUrl = "https://image-secret.example/payload.jpg";
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts", "build-listing-image-remarks.mjs"),
    path.join(fixtureScripts, "build-listing-image-remarks.mjs"),
  );
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(fixtureScripts, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "sorftime-listing-content-data.ts"),
    "export const sorftimeListingContentData = " + JSON.stringify({
      [asin]: { status: "ready", galleryImages: [imageUrl] },
    }) + ";\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(fixtureApp, "listing-image-remarks.ts"),
    "export const listingImageRemarksMeta = {};\nexport const listingImageRemarks = {};\n",
    "utf8",
  );

  let capturedPayload;
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
    });
    request.on("end", () => {
      capturedPayload = JSON.parse(body);
      if (Object.hasOwn(capturedPayload, "temperature")) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("provider-secret temperature rejected");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              remark: "bounded fixture remark",
              image_types: ["产品展示"],
              confidence: "high",
            }),
          },
        }],
      }));
    });
  });
  t.after(() => {
    provider.closeAllConnections?.();
    provider.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");

  const run = startGenerator(fixtureRoot, fixtureScripts, asin, {
    OPENAI_BASE_URL: `http://127.0.0.1:${address.port}`,
    OPENAI_VISION_MODEL: "gpt-5.5",
  });
  const result = await run.closed;

  assert.equal(result.code, 0, result.output);
  assert.ok(capturedPayload);
  assert.equal(Object.hasOwn(capturedPayload, "temperature"), false);
  assert.equal(capturedPayload.response_format?.type, "json_object");
  assert.deepEqual(capturedPayload.messages?.[0]?.content?.map(part => part.type), ["text", "image_url"]);
  assert.doesNotMatch(result.output, /provider-secret|image-secret|fixture-key/i);
});

test("generator queues every static gallery slot while skipping videos and existing remarks", () => {
  const queuePreparation = generatorSource.match(/for \(let slotIndex = 0;[\s\S]*?imageTasks\.push\(\{ asin, slotIndex, url \}\);/s)?.[0] ?? "";
  assert.match(queuePreparation, /for \(let slotIndex = 0; slotIndex < gallery\.length; slotIndex \+= 1\)/);
  assert.match(queuePreparation, /if \(isVideoThumb\(url\)\) \{[\s\S]*?continue;/);
  assert.match(
    queuePreparation,
    /if \(!force && remarks\[asin\]\[slotIndex\]\?\.remark\) \{[\s\S]*?imageRemarkOutcome\("ready"\);[\s\S]*?continue;/,
  );
  assert.match(queuePreparation, /imageTasks\.push\(\{ asin, slotIndex, url \}\);/);
});

test("generator preserves fully cached readiness and emits bounded terminal outcomes", () => {
  assert.match(generatorSource, /completeWithoutWork:\s*remarksComplete\(asin, listing\[asin\], remarks\)/);
  assert.match(generatorSource, /persistedComplete:\s*remarksComplete\(asin, listing\[asin\], remarks\)/);
  assert.match(generatorSource, /IMAGE_REMARK_OUTCOME/);
  assert.match(generatorSource, /completed-with-gaps/);
  assert.match(generatorSource, /integrity-failed/);
});

test("fully cached generator run persists ready without fabricating a new remark", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-image-remarks-cache-"));
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureApp = path.join(fixtureRoot, "app");
  const asin = "B0CACHE001";
  const existingRemark = "already cached nonblank remark";
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts", "build-listing-image-remarks.mjs"),
    path.join(fixtureScripts, "build-listing-image-remarks.mjs"),
  );
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(fixtureScripts, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "sorftime-listing-content-data.ts"),
    `export const sorftimeListingContentData = ${JSON.stringify({
      [asin]: { status: "ready", galleryImages: ["https://example.test/cached.jpg"] },
    })};\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(fixtureApp, "listing-image-remarks.ts"),
    `export const listingImageRemarks = ${JSON.stringify({
      [asin]: [{ remark: existingRemark, image_types: ["产品展示"], confidence: "high" }],
    })};\n`,
    "utf8",
  );

  try {
    const result = spawnSync(process.execPath, [path.join(fixtureScripts, "build-listing-image-remarks.mjs")], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "", REMARK_ASINS: asin },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const outputPath = path.join(fixtureApp, "listing-image-remarks.ts");
    const meta = readCachedDataExport(outputPath, "listingImageRemarksMeta");
    const remarks = readCachedDataExport(outputPath, "listingImageRemarks");
    assert.equal(meta.imageStatusByAsin[asin], "ready");
    assert.equal(meta.lastAnalyzedCount, 0);
    assert.equal(remarks[asin][0].remark, existingRemark);
    assert.match(result.stdout, /IMAGE_REMARK_OUTCOME \{"status":"completed"\}/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("a settled ready slot is durable before later work finishes and is reused after interruption", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-image-remarks-durable-"));
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureApp = path.join(fixtureRoot, "app");
  const outputPath = path.join(fixtureApp, "listing-image-remarks.ts");
  const asin = "B0DURABLE1";
  const firstUrl = "https://example.test/first-ready.jpg";
  const laterUrl = "https://example.test/later-pending.jpg";
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts", "build-listing-image-remarks.mjs"),
    path.join(fixtureScripts, "build-listing-image-remarks.mjs"),
  );
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(fixtureScripts, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "sorftime-listing-content-data.ts"),
    "export const sorftimeListingContentData = " + JSON.stringify({
      [asin]: { status: "ready", galleryImages: [firstUrl, laterUrl] },
    }) + ";\n",
    "utf8",
  );
  fs.writeFileSync(
    outputPath,
    "export const listingImageRemarksMeta = {};\nexport const listingImageRemarks = {};\n",
    "utf8",
  );

  let phase = "interrupted";
  let firstCalls = 0;
  let laterCalls = 0;
  const heldResponses = new Set();
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
    });
    request.on("end", () => {
      const first = body.includes(firstUrl);
      if (first) firstCalls += 1;
      else laterCalls += 1;
      if (!first && phase === "interrupted") {
        heldResponses.add(response);
        response.once("close", () => heldResponses.delete(response));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              remark: first ? "durable first remark" : "resumed later remark",
              image_types: ["产品展示"],
              confidence: "high",
            }),
          },
        }],
      }));
    });
  });
  let interruptedRun;
  t.after(() => {
    interruptedRun?.child.kill();
    for (const response of heldResponses) response.destroy();
    provider.closeAllConnections?.();
    provider.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = "http://127.0.0.1:" + address.port;

  interruptedRun = startGenerator(fixtureRoot, fixtureScripts, asin, { OPENAI_BASE_URL: endpoint });
  try {
    await waitForCondition(
      () => readCachedDataExport(outputPath, "listingImageRemarks")[asin]?.[0]?.remark === "durable first remark",
      "first settled ready remark was not published while the later slot was still running",
    );
  } catch (error) {
    interruptedRun.child.kill();
    await interruptedRun.closed;
    throw error;
  }
  interruptedRun.child.kill();
  await interruptedRun.closed;
  for (const response of heldResponses) response.destroy();
  heldResponses.clear();

  phase = "resume";
  const resumedRun = startGenerator(fixtureRoot, fixtureScripts, asin, { OPENAI_BASE_URL: endpoint });
  const resumed = await resumedRun.closed;
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(firstCalls, 1, "the durable ready slot must not make a second physical provider call");
  assert.equal(laterCalls, 2, "only the interrupted slot should be attempted again on resume");
  const remarks = readCachedDataExport(outputPath, "listingImageRemarks");
  assert.equal(remarks[asin][0].remark, "durable first remark");
  assert.equal(remarks[asin][1].remark, "resumed later remark");
});

test("independent generator processes atomically merge owned ASIN results", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-image-remarks-concurrent-"));
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureApp = path.join(fixtureRoot, "app");
  const asins = ["B0MERGE001", "B0MERGE002"];
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts", "build-listing-image-remarks.mjs"),
    path.join(fixtureScripts, "build-listing-image-remarks.mjs"),
  );
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(fixtureScripts, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "sorftime-listing-content-data.ts"),
    "export const sorftimeListingContentData = " + JSON.stringify(Object.fromEntries(asins.map((asin, index) => [
      asin,
      { status: "ready", galleryImages: ["https://example.test/image-" + index + ".jpg"] },
    ]))) + ";\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(fixtureApp, "listing-image-remarks.ts"),
    "export const listingImageRemarksMeta = {};\nexport const listingImageRemarks = {};\n",
    "utf8",
  );

  const held = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
    });
    request.on("end", () => {
      held.push({ body, response });
      if (held.length !== asins.length) return;
      for (const item of held) {
        const asin = asins.find(candidate => item.body.includes(candidate));
        item.response.writeHead(200, { "Content-Type": "application/json" });
        item.response.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                remark: "fixture remark " + asin,
                image_types: ["产品展示"],
                confidence: "high",
              }),
            },
          }],
        }));
      }
    });
  });
  t.after(() => {
    provider.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = "http://127.0.0.1:" + address.port;
  const runGenerator = (asin) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixtureScripts, "build-listing-image-remarks.mjs")], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: "fixture-key",
        OPENAI_BASE_URL: endpoint,
        REMARK_ASINS: asin,
        AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
    });
    child.stderr.on("data", chunk => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });

  const results = await Promise.all(asins.map(runGenerator));
  assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.output).join("\n"));
  const outputPath = path.join(fixtureApp, "listing-image-remarks.ts");
  const remarks = readCachedDataExport(outputPath, "listingImageRemarks");
  const meta = readCachedDataExport(outputPath, "listingImageRemarksMeta");
  for (const asin of asins) {
    assert.equal(remarks[asin]?.[0]?.remark, "fixture remark " + asin);
    assert.equal(meta.imageStatusByAsin[asin], "ready");
  }
});

test("overlapping same-ASIN writers reconcile a persisted ready slot against stale timeout metadata", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-image-remarks-same-asin-"));
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureApp = path.join(fixtureRoot, "app");
  const outputPath = path.join(fixtureApp, "listing-image-remarks.ts");
  const asin = "B0SAMEASIN";
  const firstUrl = "https://example.test/same-asin-slot-0.jpg";
  const secondUrl = "https://example.test/same-asin-slot-1.jpg";
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts", "build-listing-image-remarks.mjs"),
    path.join(fixtureScripts, "build-listing-image-remarks.mjs"),
  );
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(fixtureScripts, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "sorftime-listing-content-data.ts"),
    "export const sorftimeListingContentData = " + JSON.stringify({
      [asin]: { status: "ready", galleryImages: [firstUrl, secondUrl] },
    }) + ";\n",
    "utf8",
  );
  fs.writeFileSync(
    outputPath,
    "export const listingImageRemarksMeta = {};\nexport const listingImageRemarks = {};\n",
    "utf8",
  );
  const preloadPath = path.join(fixtureRoot, "shorten-test-deadline.mjs");
  fs.writeFileSync(
    preloadPath,
    "const nativeSetTimeout = globalThis.setTimeout;\n"
      + "const testTimeoutMs = Number(process.env.TEST_IMAGE_TIMEOUT_MS);\n"
      + "globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 120000 ? testTimeoutMs : delay, ...args);\n",
    "utf8",
  );

  const held = [];
  const requests = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
    });
    request.on("end", () => {
      const entry = {
        body,
        key: request.headers.authorization,
        response,
      };
      requests.push(entry);
      held.push(entry);
      response.once("close", () => {
        const index = held.indexOf(entry);
        if (index >= 0) held.splice(index, 1);
      });
      if (requests.length !== 4) return;
      const ready = held.find(item => item.key === "Bearer ready-job" && item.body.includes(firstUrl));
      assert.ok(ready, "ready job slot 0 request must reach the provider barrier");
      ready.response.writeHead(200, { "Content-Type": "application/json" });
      ready.response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              remark: "same ASIN durable ready remark",
              image_types: ["产品展示"],
              confidence: "high",
            }),
          },
        }],
      }));
    });
  });
  const runs = [];
  t.after(() => {
    for (const run of runs) run.child.kill();
    for (const entry of held) entry.response.destroy();
    provider.closeAllConnections?.();
    provider.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = "http://127.0.0.1:" + address.port;
  const preload = "--import=" + pathToFileURL(preloadPath).href;
  runs.push(startGenerator(fixtureRoot, fixtureScripts, asin, {
    OPENAI_API_KEY: "ready-job",
    OPENAI_BASE_URL: endpoint,
    NODE_OPTIONS: preload,
    TEST_IMAGE_TIMEOUT_MS: "300",
  }));
  runs.push(startGenerator(fixtureRoot, fixtureScripts, asin, {
    OPENAI_API_KEY: "stale-timeout-job",
    OPENAI_BASE_URL: endpoint,
    NODE_OPTIONS: preload,
    TEST_IMAGE_TIMEOUT_MS: "800",
  }));

  const completed = await Promise.all(runs.map(run => run.closed));
  assert.deepEqual(completed.map(result => result.code), [1, 1], completed.map(result => result.output).join("\n"));
  assert.equal(requests.length, 4);
  const remarks = readCachedDataExport(outputPath, "listingImageRemarks");
  const meta = readCachedDataExport(outputPath, "listingImageRemarksMeta");
  assert.equal(remarks[asin]?.[0]?.remark, "same ASIN durable ready remark");
  assert.equal(remarks[asin]?.[1] ?? null, null);
  assert.deepEqual(meta.imageOutcomesByAsin[asin], [
    { status: "ready", reason: "图片备注已就绪" },
    { status: "timeout", reason: "图片分析超过 120 秒" },
  ]);
  assert.equal(meta.imageStatusByAsin[asin], "timeout");
  assert.equal(meta.pendingAsins.includes(asin), true);
});

test("atomic rename failure reports integrity failure and preserves the published file", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-image-remarks-rename-"));
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureApp = path.join(fixtureRoot, "app");
  const asin = "B0ATOMIC01";
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts", "build-listing-image-remarks.mjs"),
    path.join(fixtureScripts, "build-listing-image-remarks.mjs"),
  );
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(fixtureScripts, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "sorftime-listing-content-data.ts"),
    "export const sorftimeListingContentData = " + JSON.stringify({
      [asin]: { status: "ready", galleryImages: ["https://example.test/play-button.jpg"] },
    }) + ";\n",
    "utf8",
  );
  const outputPath = path.join(fixtureApp, "listing-image-remarks.ts");
  const original = "export const listingImageRemarksMeta = { marker: \"published\" };\n"
    + "export const listingImageRemarks = { B0EXIST001: [{ remark: \"keep me\" }] };\n";
  fs.writeFileSync(outputPath, original, "utf8");
  const preloadPath = path.join(fixtureRoot, "fail-rename.mjs");
  fs.writeFileSync(
    preloadPath,
    "import fs from \"node:fs\";\n"
      + "const renameSync = fs.renameSync;\n"
      + "fs.renameSync = (source, target) => { if (String(target).endsWith(\"listing-image-remarks.ts\")) { const error = new Error(\"fixture rename failure\"); error.code = \"EIO\"; throw error; } return renameSync(source, target); };\n",
    "utf8",
  );

  try {
    const result = spawnSync(process.execPath, [path.join(fixtureScripts, "build-listing-image-remarks.mjs")], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        REMARK_ASINS: asin,
        NODE_OPTIONS: "--import=" + pathToFileURL(preloadPath).href,
      },
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /IMAGE_REMARK_OUTCOME \{"status":"integrity-failed"\}/);
    assert.equal(fs.readFileSync(outputPath, "utf8"), original);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("generator persists fixed outcomes by static slot without retaining image URLs", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-image-remarks-outcomes-"));
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureApp = path.join(fixtureRoot, "app");
  const asin = "B0OUTCOME1";
  const cachedUrl = "https://secret.test/cached.jpg";
  const failedUrl = "https://secret.test/failed.jpg";
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts", "build-listing-image-remarks.mjs"),
    path.join(fixtureScripts, "build-listing-image-remarks.mjs"),
  );
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(fixtureScripts, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "sorftime-listing-content-data.ts"),
    "export const sorftimeListingContentData = " + JSON.stringify({
      [asin]: {
        status: "ready",
        galleryImages: [cachedUrl, "https://example.test/play-button.jpg", failedUrl],
      },
    }) + ";\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(fixtureApp, "listing-image-remarks.ts"),
    "export const listingImageRemarksMeta = {};\n"
      + "export const listingImageRemarks = " + JSON.stringify({
        [asin]: [{ remark: "cached", image_types: ["产品展示"], confidence: "high" }],
      }) + ";\n",
    "utf8",
  );

  try {
    const result = spawnSync(process.execPath, [path.join(fixtureScripts, "build-listing-image-remarks.mjs")], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: " ", REMARK_ASINS: asin },
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const outputPath = path.join(fixtureApp, "listing-image-remarks.ts");
    const source = fs.readFileSync(outputPath, "utf8");
    const meta = readCachedDataExport(outputPath, "listingImageRemarksMeta");
    assert.deepEqual(meta.imageOutcomesByAsin[asin], [
      { status: "ready", reason: "图片备注已就绪" },
      null,
      { status: "connector-failed", reason: "图片分析连接器失败" },
    ]);
    assert.doesNotMatch(source, /secret\.test|cached\.jpg|failed\.jpg/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
