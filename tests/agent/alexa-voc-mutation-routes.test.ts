import assert from "node:assert/strict";
import test from "node:test";
import * as importRoute from "../../app/api/alexa-voc/import/route";
import {
  createAlexaVocImportHandler,
} from "../../app/api/alexa-voc/import/route";
import { createAlexaVocSyncHandler } from "../../app/api/alexa-voc/sync/route";
import { createSystemRebuildHandler } from "../../app/api/system/rebuild/route";

const authorized = async () => ({ ok: true as const, role: "admin" as const });
const rejected = async () => ({
  ok: false as const,
  response: Response.json({ error: "请先登录后再操作" }, { status: 401 }),
});
const completeSavedReport = {
  asin: "B0T2TASK02",
  rating: null,
  reviewCount: null,
  starBreakdown: undefined,
  overallConclusion: "done",
  sections: {
    attention: [],
    positives: [],
    negatives: [],
    unmet: [],
    audiences: [],
    scenarios: [],
    motives: [],
  },
  filled: 3,
  missing: [],
  ok: true,
  rawLineCount: 0,
};

test("unauthorized Alexa import returns before reading or writing", async () => {
  let saved = 0;
  let rebuilt = 0;
  const handler = createAlexaVocImportHandler({
    authorize: rejected,
    save: () => { saved += 1; throw new Error("must not run"); },
    rebuild: () => { rebuilt += 1; return { started: true, message: "unexpected" }; },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", headers: { origin: "http://127.0.0.1:31900" }, body: "not-json",
  }));
  assert.equal(response.status, 401);
  assert.equal(saved, 0);
  assert.equal(rebuilt, 0);
});

type RoutePolicy =
  | { name: "import"; allowedRoles: readonly ["admin", "member"]; factory: typeof createAlexaVocImportHandler }
  | { name: "sync"; allowedRoles: readonly ["admin"]; factory: typeof createAlexaVocSyncHandler }
  | { name: "rebuild"; allowedRoles: readonly ["admin"]; factory: typeof createSystemRebuildHandler };

const routePolicies: readonly RoutePolicy[] = [
  { name: "import", allowedRoles: ["admin", "member"], factory: createAlexaVocImportHandler },
  { name: "sync", allowedRoles: ["admin"], factory: createAlexaVocSyncHandler },
  { name: "rebuild", allowedRoles: ["admin"], factory: createSystemRebuildHandler },
];

test("mutation routes authorize with their policy before injected work", async () => {
  for (const policy of routePolicies) {
    const { name, allowedRoles } = policy;
    const calls: string[] = [];
    const authorize = async (_request: Request, options: { allowedRoles: readonly string[] }) => {
      calls.push("authorize");
      assert.deepEqual(options.allowedRoles, allowedRoles, `${name} policy`);
      return { ok: false as const, response: new Response(null, { status: 401 }) };
    };
    let handler: (request: Request) => Promise<Response>;
    if (policy.name === "import") {
      handler = policy.factory({
        authorize,
        save: () => { calls.push("save"); return completeSavedReport; },
        rebuild: () => { calls.push("rebuild"); return { started: true, message: "unexpected" }; },
      });
    } else if (policy.name === "sync") {
      handler = policy.factory({
        authorize,
        spawn: () => { calls.push("spawn"); return { unref() { calls.push("unref"); } }; },
        rebuild: () => { calls.push("rebuild"); return { started: true, message: "unexpected" }; },
      });
    } else {
      handler = policy.factory({
        authorize,
        rebuild: () => { calls.push("rebuild"); return { started: true, message: "unexpected" }; },
      });
    }
    const response = await handler(new Request(`http://127.0.0.1:31900/api/alexa-voc/${name}`, {
      method: "POST", headers: { origin: "http://127.0.0.1:31900" },
      body: "not-json",
    }));
    assert.equal(response.status, 401, name);
    assert.deepEqual(calls, ["authorize"], name);
  }
});

test("Alexa import maps incomplete reports to 422", async () => {
  const handler = createAlexaVocImportHandler({
    authorize: authorized,
    save: () => { throw new Error("incomplete_report · 仅识别 2/7 个维度"); },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: "report" }),
  }));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "Alexa 报告至少需要识别 3 个维度" });
});

test("Alexa import maps report ASIN mismatch to 422", async () => {
  const handler = createAlexaVocImportHandler({
    authorize: authorized,
    save: () => { throw new Error("asin_mismatch_report"); },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: "report" }),
  }));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "Alexa 报告 ASIN 与所选 ASIN 不一致" });
});

test("Alexa import maps write failures to 500", async () => {
  const handler = createAlexaVocImportHandler({
    authorize: authorized,
    save: () => { throw new Error("secret-write-sentinel"); },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: "report" }),
  }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Alexa VOC 写入失败" });
});

test("Alexa import saves before starting a rebuild", async () => {
  const calls: string[] = [];
  const handler = createAlexaVocImportHandler({
    authorize: authorized,
    save: () => {
      calls.push("save");
      return completeSavedReport;
    },
    rebuild: () => { calls.push("rebuild"); return { started: true, message: "started" }; },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: "report" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["save", "rebuild"]);
});

test("Alexa sync rejects invalid JSON with a stable 400 before spawning", async () => {
  let spawned = 0;
  const handler = createAlexaVocSyncHandler({
    authorize: authorized,
    spawn: () => { spawned += 1; throw new Error("must not run"); },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/sync", {
    method: "POST", body: "not-json",
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "请求内容不是有效 JSON" });
  assert.equal(spawned, 0);
});

test("Alexa import rejects non-object JSON before writing or rebuilding", async () => {
  for (const body of ["null", "[]"]) {
    let saved = 0;
    let rebuilt = 0;
    const handler = createAlexaVocImportHandler({
      authorize: authorized,
      save: () => { saved += 1; throw new Error("must not run"); },
      rebuild: () => { rebuilt += 1; return { started: true, message: "unexpected" }; },
    });
    const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
      method: "POST", body,
    }));
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { error: "请求内容必须是对象" }, body);
    assert.equal(saved, 0, body);
    assert.equal(rebuilt, 0, body);
  }
});

test("Alexa sync rejects non-object JSON before spawning or rebuilding", async () => {
  for (const body of ["null", "[]"]) {
    let spawned = 0;
    let rebuilt = 0;
    const handler = createAlexaVocSyncHandler({
      authorize: authorized,
      spawn: () => { spawned += 1; throw new Error("must not run"); },
      rebuild: () => { rebuilt += 1; return { started: true, message: "unexpected" }; },
    });
    const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/sync", {
      method: "POST", body,
    }));
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { error: "请求内容必须是对象" }, body);
    assert.equal(spawned, 0, body);
    assert.equal(rebuilt, 0, body);
  }
});

test("mutation routes redact rebuild failures", async () => {
  const sentinel = "rebuild-secret-sentinel";
  const importHandler = createAlexaVocImportHandler({
    authorize: authorized,
    save: () => completeSavedReport,
    rebuild: () => { throw new Error(sentinel); },
  });
  const importResponse = await importHandler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: "report" }),
  }));
  assert.equal(importResponse.status, 500);
  assert.deepEqual(await importResponse.json(), { error: "Alexa VOC 后台构建失败" });

  const syncHandler = createAlexaVocSyncHandler({
    authorize: authorized,
    spawn: () => ({ unref() {} }),
    rebuild: () => { throw new Error(sentinel); },
  });
  const syncResponse = await syncHandler(new Request("http://127.0.0.1:31900/api/alexa-voc/sync", {
    method: "POST", body: JSON.stringify({ asins: ["B0T2TASK02"], rebuild: true }),
  }));
  assert.equal(syncResponse.status, 500);
  assert.deepEqual(await syncResponse.json(), { error: "Alexa VOC 后台构建失败" });

  const rebuildHandler = createSystemRebuildHandler({
    authorize: authorized,
    rebuild: () => { throw new Error(sentinel); },
  });
  const rebuildResponse = await rebuildHandler(new Request("http://127.0.0.1:31900/api/system/rebuild", {
    method: "POST",
  }));
  assert.equal(rebuildResponse.status, 500);
  assert.deepEqual(await rebuildResponse.json(), { error: "系统后台构建失败" });
});

test("mutation route modules do not expose CORS OPTIONS handlers", () => {
  assert.equal(Object.hasOwn(importRoute, "OPTIONS"), false);
});
