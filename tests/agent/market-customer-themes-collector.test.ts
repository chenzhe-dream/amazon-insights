import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ConnectorError, type ConnectorRequest, type ConnectorResult, type RemoteMcpConnector } from "../../server/connectors/connector-contract";
import { ResourceGovernorAdmissionError } from "../../server/db/concurrency-control-repository";
import { aggregateCustomerThemes } from "../../server/domain/market-research/customer-themes";

const asin = "B07Z5NQPDS";
const scope = {
  organizationId: "org-a", researchId: "20000000-0000-4000-8000-000000000001", marketplace: "US" as const,
  nodeIdPath: "123:456", fromMonth: "2026-07", toMonth: "2026-08", currency: "USD" as const,
};
const fetchedAt = "2026-09-12T06:51:38.687Z";
const now = () => new Date("2026-09-12T07:00:00.000Z");
const row = (patch: Record<string, unknown> = {}) => ({
  keyword: "assembly", content: "Customers discuss assembly", mention: 10, positive: 10, negative: 1,
  update_time: "2026-09-03", ...patch,
});
const payload = (details: unknown[] = [row()]) => ({ data: { customer_say: "A source summary", details } });
const saved = JSON.parse(readFileSync(new URL("../fixtures/market/floor-customers-say.json", import.meta.url), "utf8")) as {
  payload: { data: { customer_say: string; details: Record<string, unknown>[] } };
};
function connector(handler: (request: ConnectorRequest) => ConnectorResult["data"] | Promise<ConnectorResult["data"]>, sourcePatch: Partial<ConnectorResult["source"]> = {}): RemoteMcpConnector {
  return {
    id: "sorftime", probe: async () => { throw new Error("No probe expected"); },
    execute: async (request) => ({ data: await handler(request), source: {
      connectorId: "sorftime", operation: "product_customers_say", fetchedAt, attemptCount: 1, ...sourcePatch,
    } }),
  };
}
const callInput = (source = connector(() => payload())) => ({ scope, asin, connector: source, jobId: "job-cs-1", now, timeoutMs: 1000 });
async function api() {
  try { return await import("../../server/services/market-customer-themes-collector"); }
  catch (error) { assert.fail(`Customers Say collector is required: ${(error as NodeJS.ErrnoException).code}`); }
}

test("real saved source replay makes one governed US request and returns all 19 original themes for T5", async () => {
  const { collectMarketCustomerThemes } = await api();
  const calls: ConnectorRequest[] = [];
  const result = await collectMarketCustomerThemes(callInput(connector((request) => { calls.push(request); return saved.payload; })));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "product_customers_say");
  assert.deepEqual(calls[0].input, { asin, site: "US" });
  assert.deepEqual(calls[0].governorScope, { organizationId: "org-a", jobId: "job-cs-1" });
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(result.result.status, "success");
  if (result.result.status !== "success") assert.fail("Expected success");
  assert.equal(result.result.themes.length, 19);
  assert.equal(result.summary, saved.payload.data.customer_say);
  assert.deepEqual(result.rawPayload, saved.payload);
  assert.deepEqual(result.evidence?.payload, saved.payload);
  assert.equal(result.result.themes[3].mention, 15);
  assert.equal(result.result.themes[3].positive, 15);
  assert.equal(result.result.themes[3].negative, 1);
  assert.equal(result.result.themes[0].sourceUpdatedAt, "2026-09-03");
  const aggregate = aggregateCustomerThemes({ selectedAsins: [asin], results: [result.result], mappings: [] });
  assert.equal(aggregate.totals?.mention, 672);
  assert.equal(aggregate.dataReady, true);
  assert.equal(JSON.stringify(result).includes('"reviewId"'), false);
});

test("source evidence hashes the original payload and stable IDs include hash, ASIN, and original index", async () => {
  const { collectMarketCustomerThemes } = await api();
  const sourcePayload = payload([row(), row()]);
  const result = await collectMarketCustomerThemes(callInput(connector(() => sourcePayload)));
  assert.ok(result.evidence);
  assert.equal(result.evidence.payloadHash, createHash("sha256").update(JSON.stringify(result.evidence.payload)).digest("hex"));
  if (result.result.status !== "success") assert.fail("Expected success");
  const recordId = `customers-say:${result.evidence.payloadHash}:${asin}`;
  assert.equal(result.result.source.sourceRecordId, recordId);
  assert.deepEqual(result.result.themes.map((theme) => theme.sourceThemeId), [`${recordId}:0`, `${recordId}:1`]);
  const equivalent = { data: { details: [
    { update_time: "2026-09-03", negative: 1, positive: 10, mention: 10, content: "Customers discuss assembly", keyword: "assembly" }, row(),
  ], customer_say: "A source summary" } };
  const reordered = await collectMarketCustomerThemes(callInput(connector(() => equivalent)));
  assert.equal(reordered.evidence?.payloadHash, result.evidence.payloadHash);
  if (reordered.result.status !== "success") assert.fail("Expected success");
  assert.deepEqual(reordered.result.themes.map((theme) => theme.sourceThemeId), result.result.themes.map((theme) => theme.sourceThemeId));
  const changed = await collectMarketCustomerThemes(callInput(connector(() => payload([row({ mention: 11 }), row()]))));
  assert.notEqual(changed.evidence?.payloadHash, result.evidence.payloadHash);
});

test("missing identity echo stays unverified and update dates never become a historical sampling period", async () => {
  const { collectMarketCustomerThemes } = await api();
  const result = await collectMarketCustomerThemes(callInput());
  assert.equal(result.evidence?.responseIdentity.asin.status, "unverified");
  assert.equal(result.evidence?.responseIdentity.marketplace.reason, "not-echoed");
  assert.equal(result.evidence?.observationPeriod.kind, "unknown");
  assert.equal(Object.hasOwn(result.evidence?.requestIdentity ?? {}, "month"), false);
  assert.equal(result.scope.toMonth, "2026-08");
  if (result.result.status !== "success") assert.fail("Expected success");
  assert.equal(result.result.source.sourceUpdatedAt, null);
  assert.equal(result.result.themes[0].sourceUpdatedAt, "2026-09-03");
});

test("actual root, business, and per-row identity echoes are all checked with equivalent normalization", async () => {
  const { collectMarketCustomerThemes } = await api();
  const echoed = { asin: asin.toLowerCase(), site: "us", data: {
    asin, marketplace: "US", customer_say: "summary", details: [row({ ASIN: asin, amz_site: "US" })],
  } };
  const result = await collectMarketCustomerThemes(callInput(connector(() => echoed)));
  assert.equal(result.result.status, "success");
  assert.equal(result.evidence?.responseIdentity.asin.status, "verified");
  assert.equal(result.evidence?.responseIdentity.asin.echoes.length, 3);
  assert.equal(result.evidence?.responseIdentity.marketplace.echoes.length, 3);
});

test("wrong ASIN or site at any supported identity location retains raw diagnostic data but no valid evidence", async () => {
  const { collectMarketCustomerThemes } = await api();
  for (const bad of [
    { ...payload(), asin: "B000000001" }, { ...payload(), site: "GB" },
    { data: { ...payload().data, Asin: "B000000001" } },
    { data: { ...payload().data, marketplace: "GB" } },
    payload([row({ asin: "B000000001" })]), payload([row({ site: "GB" })]),
  ]) {
    const result = await collectMarketCustomerThemes(callInput(connector(() => bad)));
    assert.equal(result.result.status, "failed");
    assert.equal(result.evidence, null);
    assert.deepEqual(result.rawPayload, bad);
    assert.equal(result.issues[0].code, "identity-mismatch");
  }
});

test("an explicit empty details list and the sole exact observed no-data text are empty outcomes", async () => {
  const { collectMarketCustomerThemes } = await api();
  for (const empty of [{ data: { details: [] } }, payload([]), { content: [{ type: "text", text: " No relevant data. " }] }]) {
    const result = await collectMarketCustomerThemes(callInput(connector(() => empty)));
    assert.equal(result.result.status, "empty");
    assert.ok(result.evidence);
    assert.deepEqual(result.rawPayload, empty);
    const aggregate = aggregateCustomerThemes({ selectedAsins: [asin], results: [result.result], mappings: [] });
    assert.equal(aggregate.dataReady, false);
  }
});

test("ambiguous/error/mixed no-data messages never become a successful empty result", async () => {
  const { collectMarketCustomerThemes } = await api();
  const text = { content: [{ type: "text", text: "No relevant data." }] };
  for (const bad of [
    { content: [{ type: "text", text: "No data available." }] },
    { ...text, isError: true }, { ...text, structuredContent: { data: { details: [] } } },
    { content: [...text.content, { type: "text", text: "Unauthorized" }] },
    { data: { error: "Unauthorized", details: [] }, isError: true },
  ]) {
    const result = await collectMarketCustomerThemes(callInput(connector(() => bad)));
    assert.equal(result.result.status, "failed");
    assert.equal(result.evidence, null);
    assert.deepEqual(result.rawPayload, bad);
  }
});

test("a no-data text envelope cannot override simultaneously supplied source theme data", async () => {
  const { collectMarketCustomerThemes } = await api();
  const contradictory = { ...payload(), content: [{ type: "text", text: "No relevant data." }] };
  const result = await collectMarketCustomerThemes(callInput(connector(() => contradictory)));
  assert.equal(result.result.status, "failed");
  assert.equal(result.evidence, null);
  assert.deepEqual(result.rawPayload, contradictory);
});

test("invalid required theme counts fail only this ASIN while preserving all raw rows and indexed issues", async () => {
  const { collectMarketCustomerThemes } = await api();
  for (const patch of [
    { mention: -1 }, { positive: 11 }, { negative: 11 }, { mention: 1.5 },
    { mention: "10" }, { mention: null }, { mention: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const bad = payload([row(), row(patch)]);
    const result = await collectMarketCustomerThemes(callInput(connector(() => bad)));
    assert.equal(result.result.status, "failed");
    assert.equal(result.evidence, null);
    assert.deepEqual(result.rawPayload, bad);
    assert.equal(result.issues[0].code, "invalid-theme");
    assert.deepEqual(result.issues[0].path?.slice(0, 3), ["data", "details", 1]);
  }
  const missing = row(); delete (missing as Partial<ReturnType<typeof row>>).mention;
  const result = await collectMarketCustomerThemes(callInput(connector(() => payload([missing]))));
  assert.equal(result.result.status, "failed");
  assert.ok(result.rawPayload);
});

test("missing fields and impossible topic update dates fail without inferring a replacement date", async () => {
  const { collectMarketCustomerThemes } = await api();
  for (const patch of [{ update_time: "2026-02-30" }, { update_time: "2026-9-3" }, { update_time: null }, { keyword: " " }, { content: 3 }]) {
    const result = await collectMarketCustomerThemes(callInput(connector(() => payload([row(patch)]))));
    assert.equal(result.result.status, "failed");
    assert.equal(result.issues[0].code, "invalid-theme");
    assert.equal(result.evidence, null);
  }
});

test("a source whose total mentions overflow cannot emit a success result rejected by T5", async () => {
  const { collectMarketCustomerThemes } = await api();
  const invalid = payload([
    row({ mention: Number.MAX_SAFE_INTEGER, positive: 0, negative: 0 }),
    row({ mention: 1, positive: 0, negative: 0 }),
  ]);
  const result = await collectMarketCustomerThemes(callInput(connector(() => invalid)));
  assert.equal(result.result.status, "failed");
  assert.equal(result.evidence, null);
  assert.deepEqual(result.rawPayload, invalid);
  assert.equal(result.issues[0].code, "invalid-theme");
  assert.deepEqual(result.issues[0].path, ["data", "details", 1, "mention"]);
});

test("malformed business envelope fails closed and missing summary can remain unknown with usable themes", async () => {
  const { collectMarketCustomerThemes } = await api();
  for (const bad of [{}, { data: {} }, { data: { details: null } }, { data: { customer_say: 4, details: [row()] } }]) {
    const result = await collectMarketCustomerThemes(callInput(connector(() => bad)));
    assert.equal(result.result.status, "failed");
    assert.equal(result.evidence, null);
    assert.deepEqual(result.rawPayload, bad);
  }
  const usable = await collectMarketCustomerThemes(callInput(connector(() => ({ data: { details: [row()] } }))));
  assert.equal(usable.result.status, "success");
  assert.equal(usable.summary, null);
});

test("payload validation precedes any getter access and non-JSON numbers remain an explicit raw gap", async () => {
  const { collectMarketCustomerThemes } = await api();
  let getterCalls = 0;
  const hooked: Record<string, unknown> = {};
  Object.defineProperty(hooked, "data", { enumerable: true, get() { getterCalls++; return payload().data; } });
  for (const bad of [hooked, payload([row({ mention: Infinity })]), payload([row({ positive: NaN })])]) {
    const result = await collectMarketCustomerThemes(callInput(connector(() => bad)));
    assert.equal(result.result.status, "failed");
    assert.equal(result.rawPayload, null);
    assert.equal(result.evidence, null);
    assert.ok(result.rawUnavailableReason);
  }
  assert.equal(getterCalls, 0);
});

test("untrusted connector source identity or future fetchedAt cannot validate a payload", async () => {
  const { collectMarketCustomerThemes } = await api();
  for (const sourcePatch of [
    { connectorId: "sif" as const }, { operation: "product_detail" },
    { fetchedAt: "2026-09-13T00:00:00.000Z" }, { fetchedAt: "not-a-time" }, { attemptCount: 0 },
  ]) {
    const raw = payload();
    const result = await collectMarketCustomerThemes(callInput(connector(() => raw, sourcePatch)));
    assert.equal(result.result.status, "failed");
    assert.equal(result.evidence, null);
    assert.deepEqual(result.rawPayload, raw);
    assert.equal(result.issues[0].code, "source-mismatch");
  }
});

test("caller scope, provider, ASIN, job ID, timeout and clock validation happen before any execute", async () => {
  const { collectMarketCustomerThemes } = await api();
  let calls = 0;
  const remote = connector(() => { calls++; return payload(); });
  const original = callInput(remote);
  for (const patch of [
    { asin: "bad" }, { scope: { ...scope, toMonth: "2026-09" } }, { jobId: " " },
    { timeoutMs: 0 }, { timeoutMs: 120001 }, { timeoutMs: 1.5 }, { now: () => new Date("invalid") },
    { connector: { ...remote, id: "sif" as const } },
  ]) await assert.rejects(() => collectMarketCustomerThemes({ ...original, ...patch }));
  assert.equal(calls, 0);
  const normalized = await collectMarketCustomerThemes({ ...original, asin: ` ${asin.toLowerCase()} ` });
  assert.equal(normalized.asin, asin);
});

test("already-cancelled input produces a cancelled failure without dispatch", async () => {
  const { collectMarketCustomerThemes } = await api();
  let calls = 0;
  const controller = new AbortController(); controller.abort(new Error("private user cancellation detail"));
  const result = await collectMarketCustomerThemes({ ...callInput(connector(() => { calls++; return payload(); })), signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(result.result.status, "failed");
  assert.equal(result.issues[0].code, "cancelled");
  assert.equal(result.evidence, null);
  assert.equal(JSON.stringify(result).includes("private user cancellation detail"), false);
});

test("in-flight cancellation aborts the dispatched signal and does not dispatch a second request", async () => {
  const { collectMarketCustomerThemes } = await api();
  const controller = new AbortController();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const pending = collectMarketCustomerThemes({ ...callInput(connector((request) => {
    calls++; signal = request.signal; controller.abort();
    return new Promise<ConnectorResult["data"]>(() => {});
  })), signal: controller.signal });
  const result = await pending;
  assert.equal(result.issues[0].code, "cancelled");
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test("the collector deadline bounds an unresponsive connector and propagates abort", async () => {
  const { collectMarketCustomerThemes } = await api();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const result = await collectMarketCustomerThemes({ ...callInput(connector((request) => {
    calls++; signal = request.signal; return new Promise<ConnectorResult["data"]>(() => {});
  })), timeoutMs: 10 });
  assert.equal(result.result.status, "failed");
  assert.equal(result.issues[0].code, "timeout");
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test("elapsed deadline rejects a synchronous late response before its timer gets a turn", async () => {
  const { collectMarketCustomerThemes } = await api();
  let calls = 0;
  let childSignal: AbortSignal | undefined;
  const result = await collectMarketCustomerThemes({ ...callInput(connector((request) => {
    calls++;
    childSignal = request.signal;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    return payload();
  })), timeoutMs: 10 });
  assert.equal(result.result.status, "failed");
  assert.equal(result.issues[0].code, "timeout");
  assert.equal(result.evidence, null);
  assert.equal(result.result.source, null);
  assert.equal(childSignal?.aborted, true);
  assert.equal(calls, 1);
});

test("elapsed deadline also classifies a synchronous late rejection as timeout", async () => {
  const { collectMarketCustomerThemes } = await api();
  let childSignal: AbortSignal | undefined;
  const result = await collectMarketCustomerThemes({ ...callInput(connector((request) => {
    childSignal = request.signal;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    throw new ConnectorError("sorftime", "authentication", false);
  })), timeoutMs: 10 });
  assert.equal(result.result.status, "failed");
  assert.equal(result.issues[0].code, "timeout");
  assert.equal(result.evidence, null);
  assert.equal(childSignal?.aborted, true);
});

test("a deadline exhausted before the dispatch microtask does not send a request", async () => {
  const { collectMarketCustomerThemes } = await api();
  let calls = 0;
  queueMicrotask(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); });
  const result = await collectMarketCustomerThemes({ ...callInput(connector(() => { calls++; return payload(); })), timeoutMs: 10 });
  assert.equal(result.result.status, "failed");
  assert.equal(result.issues[0].code, "timeout");
  assert.equal(calls, 0);
});

test("parent cancellation retains priority when a synchronous phase also exceeds the deadline", async () => {
  const { collectMarketCustomerThemes } = await api();
  const controller = new AbortController();
  let childSignal: AbortSignal | undefined;
  const result = await collectMarketCustomerThemes({ ...callInput(connector((request) => {
    childSignal = request.signal;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    controller.abort(new Error("private reason"));
    return payload();
  })), signal: controller.signal, timeoutMs: 10 });
  assert.equal(result.result.status, "failed");
  assert.equal(result.issues[0].code, "cancelled");
  assert.equal(result.evidence, null);
  assert.equal(childSignal?.aborted, true);
  assert.equal(JSON.stringify(result).includes("private reason"), false);
});

test("connector failures are safely distinct without echoing raw exception messages", async () => {
  const { collectMarketCustomerThemes } = await api();
  for (const [error, expected] of [
    [new ConnectorError("sorftime", "authentication", false), "authentication"],
    [new ConnectorError("sorftime", "configuration", false), "configuration"],
    [new ConnectorError("sorftime", "rate-limit", true), "rate-limit"],
    [new ConnectorError("sorftime", "timeout", true), "timeout"],
    [new ResourceGovernorAdmissionError(), "governor-rejected"],
    [new Error("secret-token-and-private-stack"), "upstream-permanent"],
  ] as const) {
    const result = await collectMarketCustomerThemes(callInput(connector(() => { throw error; })));
    assert.equal(result.issues[0].code, expected);
    assert.equal(result.result.status, "failed");
    assert.equal(result.evidence, null);
    assert.equal(JSON.stringify(result).includes("secret-token-and-private-stack"), false);
  }
});

test("a response arriving after cancellation cannot be returned as successful source evidence", async () => {
  const { collectMarketCustomerThemes } = await api();
  const controller = new AbortController();
  const result = await collectMarketCustomerThemes({ ...callInput(connector(() => { controller.abort(); return payload(); })), signal: controller.signal });
  assert.equal(result.result.status, "failed");
  assert.equal(result.issues[0].code, "cancelled");
  assert.equal(result.evidence, null);
});

test("source payload and returned evidence detach from later connector-owned mutation", async () => {
  const { collectMarketCustomerThemes } = await api();
  const raw = payload();
  const result = await collectMarketCustomerThemes(callInput(connector(() => raw)));
  raw.data.customer_say = "mutated";
  assert.equal(result.summary, "A source summary");
  assert.notEqual(result.rawPayload, raw);
  assert.equal(Object.isFrozen(result.rawPayload), true);
});


test('quarantine mode retains valid rows at original indices and flags incomplete coverage',async()=>{
 const {collectMarketCustomerThemes}=await api();
 const raw=payload([row({mention:9,positive:9,negative:76}),row({keyword:'brightness',mention:10,positive:8,negative:2})]);
 const result=await collectMarketCustomerThemes({...callInput(connector(()=>raw)),quarantineInvalidThemes:true});
 assert.equal(result.result.status,'success');assert.deepEqual(result.rawPayload,raw);assert.deepEqual(result.evidence!.payload,raw);
 if(result.result.status!=='success')return;
 assert.equal(result.result.themes.length,1);assert.match(result.result.themes[0].sourceThemeId,/:1$/);
 assert.equal(result.result.quarantine!.receivedCount,2);assert.deepEqual(result.result.quarantine!.rejected.map(r=>r.index),[0]);
 const a=aggregateCustomerThemes({selectedAsins:[asin],results:[result.result],mappings:[]});
 assert.equal(a.coverage.status,'partial');assert.equal(a.totals!.mention,10);assert.equal(a.coverage.quarantinedThemeCount,1);
 assert.equal(a.groups[0].topicShare.denominator,10);
 const allBad=await collectMarketCustomerThemes({...callInput(connector(()=>payload([row({positive:999})]))),quarantineInvalidThemes:true});
 assert.equal(allBad.result.status,'failed');assert.ok(allBad.rawPayload);
 const legacy=await collectMarketCustomerThemes(callInput(connector(()=>raw)));assert.equal(legacy.result.status,'failed');
});


test('oversized invalid theme partitions fail normally and retain raw evidence in both modes', async () => {
 const { collectMarketCustomerThemes } = await api();
 const raw = payload([...Array.from({length: 2001}, () => row({negative: 99})), row()]);
 for (const quarantineInvalidThemes of [false, true]) {
  const result = await collectMarketCustomerThemes({...callInput(connector(() => raw)), quarantineInvalidThemes});
  assert.equal(result.result.status, 'failed');
  assert.equal(result.issues[0].code, 'invalid-theme');
  assert.deepEqual(result.rawPayload, raw);
  assert.equal(result.evidence, null);
 }
});

test('observed Sorftime contradictions isolate four rows while retaining the other 28 themes',async()=>{
 const {collectMarketCustomerThemes}=await api();
 for(const [file,usable,rejected] of [['floor-customers-say-invalid-count.json',21,[1]],['floor-customers-say-multiple-invalid-counts.json',7,[4,6,7]]] as const){
  const saved=JSON.parse(readFileSync(new URL('../fixtures/market/'+file,import.meta.url),'utf8')),raw=saved.payload??saved;
  const result=await collectMarketCustomerThemes({...callInput(connector(()=>raw)),quarantineInvalidThemes:true});assert.equal(result.result.status,'success');if(result.result.status!=='success')return;
  assert.equal(result.result.themes.length,usable);assert.deepEqual(result.result.quarantine!.rejected.map(r=>r.index),rejected);
  assert.deepEqual(result.evidence!.payload,raw);const expected=raw.data.details.filter((_:unknown,i:number)=>!(rejected as readonly number[]).includes(i)).reduce((n:number,r:any)=>n+r.mention,0);
  const a=aggregateCustomerThemes({selectedAsins:[asin],results:[result.result],mappings:[]});assert.equal(a.totals!.mention,expected);assert.ok(a.groups.every(g=>g.topicShare.denominator===expected));
 }
});
