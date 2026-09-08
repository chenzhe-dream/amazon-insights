import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startPostgresTestContainer } from "../agent/helpers/postgres-test-container";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";
import type { XydcOrderProgressRecord } from "../../shared/xydc-order-progress";
import { parseXydcJobIdentity, createXydcJobAuthority, writeXydcOrderProgress, readXydcOrderProgress, xydcOrderProgressPath, cleanupXydcOrderProgress } from "../../scripts/lib/xydc-order-job-progress";
import { XydcOrderProgressRecordSchema } from "../../shared/xydc-order-progress";
import { createXydcOrderProgressWriter } from "../../scripts/lib/xydc-order-job-lifetime";

const identity = { organizationId: "org", projectId: "project", runId: "run", jobId: "job", workerId: "worker", leaseGeneration: 1 };
const asins = ["B000000001", "B000000002", "B000000003"];
const scope = { organizationId: "org", projectId: "project", currentRunId: "run", country: "US", asins };
const families: XydcVariantFamily[] = [{ inputAsin: asins[0]!, parentAsin: "B000000010", country: "US", dimensions: [],
  children: asins.map(asin => ({ asin, attributes: [], title: null, imageUrl: null, price: null, currency: null, stars: null,
    productPageRatings: null, listingDate: null, infoStatus: "pending" })), sourceUpdatedAt: null,
  fetchedAt: new Date().toISOString(), status: "partial", reasonCode: "PARTIAL_CHILD_INFO", cacheState: "fresh" }];
function record(): XydcOrderProgressRecord {
  return { version: 1, ...identity, country: "US", window: getXydcOrderWindow(new Date()),
    families: [{ parentAsin: "B000000010", childAsins: asins }], children: asins.map((asin, index) => ({ asin,
      state: index === 0 ? "cached" : index === 1 ? "ready" : "failed", reasonCode: index === 2 ? "RPC_ERROR" : null })),
    state: "partial", updatedAt: new Date().toISOString(), retryAt: null, safeReason: "RPC_ERROR" };
}
test("standalone is distinct from any partial or malformed job envelope", () => {
  assert.equal(parseXydcJobIdentity({ NODE_ENV: "test" }), null);
  for (const env of [{ AGENT_SYNC_JOB_ID: "job" }, { AGENT_XYDC_LEASE_GENERATION: "2" }, { AGENT_XYDC_PARENT_IPC: "1" }]) {
    assert.throws(() => parseXydcJobIdentity({ NODE_ENV: "test", ...env }), /XYDC_JOB_CONTEXT_INVALID/);
  }
});

test("a ready fact with an error cannot become a trusted ready count", () => {
  const invalid = record();
  invalid.children[0]!.reasonCode = "RPC_ERROR";
  assert.equal(XydcOrderProgressRecordSchema.safeParse(invalid).success, false);
});

test("heartbeat cannot queue old collecting facts behind a terminal write awaiting authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-heartbeat-race-"));
  let release: (() => void) | undefined;
  let block = false;
  const signal = new AbortController().signal;
  const writer = createXydcOrderProgressWriter(root, async () => {
    if (block) { block = false; await new Promise<void>(resolve => { release = resolve; }); }
  }, signal);
  try {
    await writer.publish({ ...record(), state: "collecting" }, signal);
    block = true;
    const terminal = writer.publish(record(), signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(release, "terminal write reached the held authority read");
    const heartbeat = writer.heartbeat();
    release();
    await Promise.all([terminal, heartbeat]);
    assert.equal(JSON.parse(await readFile(xydcOrderProgressPath(root, identity), "utf8")).state, "partial");
  } finally { release?.(); await writer.close(); await rm(root, { recursive: true, force: true }); }
});

test("terminal cleanup preserves active and unknown files and removes only expired verified records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-cleanup-"));
  try {
    const old = { ...record(), updatedAt: new Date(Date.now() - 86_400_001).toISOString() };
    const signal = new AbortController().signal;
    await writeXydcOrderProgress(root, old, async () => {}, signal);
    const active = { ...old, jobId: "active", state: "collecting" as const };
    await writeXydcOrderProgress(root, active, async () => {}, signal);
    const unknown = path.join(path.dirname(xydcOrderProgressPath(root, old)), "unknown.json");
    await writeFile(unknown, "do not delete");
    cleanupXydcOrderProgress(root);
    await assert.rejects(() => readFile(xydcOrderProgressPath(root, old)));
    assert.equal(JSON.parse(await readFile(xydcOrderProgressPath(root, active), "utf8")).state, "collecting");
    assert.equal(await readFile(unknown, "utf8"), "do not delete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isolated PostgreSQL authority and bounded sidecars follow fixed lease, run and family scope", async () => {
  const fixture = await startPostgresTestContainer();
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-progress-"));
  try {
    await fixture.pool.query(`CREATE TABLE analysis_runs(id text PRIMARY KEY, organization_id text, project_id text, status text);
      CREATE TABLE sync_jobs(job_id text PRIMARY KEY, organization_id text, project_id text, run_id text, marketplace text,
      asins jsonb, status text, leased_by text, lease_generation integer, lease_expires_at timestamptz, created_at timestamptz DEFAULT now());
      INSERT INTO analysis_runs VALUES ('run','org','project','running')`);
    await fixture.pool.query(`INSERT INTO sync_jobs(job_id,organization_id,project_id,run_id,marketplace,asins,status,leased_by,lease_generation,lease_expires_at)
      VALUES ('job','org','project','run','US',$1,'running','worker',1,now()+interval '1 hour')`, [JSON.stringify(asins)]);
    const authority = createXydcJobAuthority(fixture.pool);
    const signal = new AbortController().signal;
    const authorize = () => authority.assert(identity, scope, signal);
    await authorize();
    for (const state of ["succeeded", "partial", "failed"]) {
      await fixture.pool.query("UPDATE analysis_runs SET status=$1", [state]);
      await authorize();
    }
    await writeXydcOrderProgress(root, record(), authorize, signal);
    const read = () => readXydcOrderProgress(root, scope, families, authority);
    assert.deepEqual((await read())?.progress && { ready: (await read())!.progress!.ready, cached: (await read())!.progress!.cached, total: (await read())!.progress!.total }, { ready: 2, cached: 1, total: 3 });
    for (const wrong of [{ organizationId: "other" }, { projectId: "other" }, { currentRunId: "old" }, { country: "CA" }, { asins: ["B000000099"] }]) {
      assert.equal(await readXydcOrderProgress(root, { ...scope, ...wrong }, families, authority), null);
    }
    assert.equal((await readXydcOrderProgress(root, scope, [{ ...families[0]!, children: families[0]!.children.slice(0, 2) }], authority))?.progress, null);
    await fixture.pool.query("UPDATE analysis_runs SET status='cancelled'");
    await assert.rejects(authorize, /CANCELLED/);
    assert.equal((await read())?.progress?.state, "cancelled");
    await assert.rejects(() => writeXydcOrderProgress(root, record(), authorize, signal), /CANCELLED/);
    await fixture.pool.query("UPDATE analysis_runs SET status='succeeded'");
    await fixture.pool.query("UPDATE sync_jobs SET status='failed'");
    await assert.rejects(authorize);
    assert.equal((await read())?.progress?.state, "failed");
    await fixture.pool.query("UPDATE sync_jobs SET status='running', leased_by='new-owner'");
    await assert.rejects(authorize);
    assert.equal((await read())?.progress?.state, "interrupted");
    await fixture.pool.query("UPDATE sync_jobs SET leased_by='worker', lease_expires_at=now()-interval '1 second'");
    await assert.rejects(authorize);
    assert.equal((await read())?.progress?.state, "interrupted");
    await fixture.pool.query("UPDATE sync_jobs SET status='completed', leased_by=NULL, lease_expires_at=NULL");
    assert.equal((await read())?.progress?.state, "partial");
    await fixture.pool.query("UPDATE sync_jobs SET lease_generation=2");
    assert.equal((await read())?.progress, null);
    await fixture.pool.query("UPDATE sync_jobs SET lease_generation=1, status='running', leased_by='worker', lease_expires_at=now()+interval '1 hour'");
    const stale = { ...record(), state: "collecting" as const, updatedAt: new Date(Date.now()-46_000).toISOString() };
    await writeXydcOrderProgress(root, stale, authorize, signal);
    assert.equal((await read())?.progress?.state, "interrupted");
    const file = xydcOrderProgressPath(root, identity);
    for (const contents of ["broken", " ".repeat(65_537), JSON.stringify({ ...record(), window: getXydcOrderWindow(new Date("2025-01-01")) })]) {
      await writeFile(file, contents);
      assert.equal((await read())?.progress, null);
    }
    await writeXydcOrderProgress(root, record(), authorize, signal);
    const before = await readFile(file, "utf8");
    const phase = new AbortController();
    await assert.rejects(() => writeXydcOrderProgress(root, { ...record(), state: "failed" }, async () => { phase.abort(); }, phase.signal));
    assert.equal(await readFile(file, "utf8"), before);
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
