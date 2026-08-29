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

const routePolicies = [
  ["import", createAlexaVocImportHandler as (dependencies: any) => (request: Request) => Promise<Response>, ["admin", "member"]],
  ["sync", createAlexaVocSyncHandler as (dependencies: any) => (request: Request) => Promise<Response>, ["admin"]],
  ["rebuild", createSystemRebuildHandler as (dependencies: any) => (request: Request) => Promise<Response>, ["admin"]],
] as const;

test("mutation routes authorize with their policy before injected work", async () => {
  for (const [name, factory, allowedRoles] of routePolicies) {
    const calls: string[] = [];
    const authorize = async (_request: Request, options: { allowedRoles: readonly string[] }) => {
      calls.push("authorize");
      assert.deepEqual(options.allowedRoles, allowedRoles, `${name} policy`);
      return { ok: false as const, response: new Response(null, { status: 401 }) };
    };
    const dependencies = {
      authorize,
      save: () => { calls.push("save"); },
      rebuild: () => { calls.push("rebuild"); return { started: true, message: "unexpected" }; },
      spawn: () => { calls.push("spawn"); return { unref() { calls.push("unref"); } }; },
    };
    const handler = factory(dependencies);
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
      return {
        filled: 3, missing: [], overallConclusion: "done",
        sections: { attention: [], positives: [], negatives: [] },
      };
    },
    rebuild: () => { calls.push("rebuild"); return { started: true, message: "started" }; },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: "report" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["save", "rebuild"]);
});

test("mutation route modules do not expose CORS OPTIONS handlers", () => {
  assert.equal(Object.hasOwn(importRoute, "OPTIONS"), false);
});
