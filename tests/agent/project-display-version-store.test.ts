import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { LocalDataStageOutputResponseSchema } from "../../shared/agent-contracts";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresProjectDisplayVersionStore, StaleProjectDisplayCandidateError } from "../../server/db/postgres/project-display-version-store";
import { startPostgresTestContainer, type PostgresTestContainer } from "./helpers/postgres-test-container";

const NOW = "2026-09-21T10:00:00.000Z";
const ASINS = ["B07YGQVKDY", "B00BCX842K", "B09JB8CSXX", "B0DPQGFM8Q",
  "B0CRMDJCF4", "B004FM8WY0", "B0GY86VNQ2", "B0CB9LGMQY"];
const OTHER_STAGES = ["keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic", "child_sales", "price_strategy"];
let postgres: PostgresTestContainer;

before(async () => { postgres = await startPostgresTestContainer(); });
after(async () => { await postgres?.close(); });

async function fixture(options: { status?: "queued" | "completed" | "failed"; asins?: string[] } = {}) {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const ids = { organizationId: randomUUID(), actorId: randomUUID(), projectId: randomUUID(), runId: randomUUID(), jobId: randomUUID() };
  const asins = options.asins ?? ASINS;
  await pool.query(`INSERT INTO users (id,organization_id,email,display_name,role,status,created_at,updated_at)
    VALUES ($1,$2,$3,'Tester','member','active',$4,$4)`, [ids.actorId, ids.organizationId, `${ids.actorId}@example.test`, NOW]);
  await pool.query(`INSERT INTO projects (id,organization_id,name,marketplace,asins_json,created_by,created_at,updated_at)
    VALUES ($1,$2,'Drift cars','US',$3::jsonb,$4,$5,$5)`, [ids.projectId, ids.organizationId, JSON.stringify(asins), ids.actorId, NOW]);
  await pool.query(`INSERT INTO analysis_runs (id,project_id,mode,status,created_by,data_cutoff_at,idempotency_scope,idempotency_key,created_at,updated_at)
    VALUES ($1,$2,'existing-data','succeeded',$3,$4,$5,$6,$4,$4)`, [ids.runId, ids.projectId, ids.actorId, NOW, `sync:${ids.organizationId}:${ids.projectId}`, ids.jobId]);
  await pool.query(`INSERT INTO sync_jobs (job_id,organization_id,project_id,run_id,actor_id,fingerprint,marketplace,asins,status,message,current_stage_id,stages,created_at,updated_at,completed_at)
    VALUES ($1,$2,$3,$4,$5,$6,'US',$7::jsonb,$8,'done','done','[]'::jsonb,$9,$9,$10)`, [ids.jobId, ids.organizationId, ids.projectId, ids.runId, ids.actorId, randomUUID(), JSON.stringify(asins), options.status ?? "completed", NOW, options.status === "queued" ? null : NOW]);
  await seedAllOutputs(pool, ids);
  return { pool, ids, asins, store: new PostgresProjectDisplayVersionStore(new PostgresQueryContext(pool)) };
}

function hash(value: unknown) {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function imageOutput(pool: Pool, ids: Awaited<ReturnType<typeof fixture>>["ids"], imageCount = 7) {
  const remarks = Array.from({ length: imageCount }, (_, index) => ({ slotIndex: index, remark: `Image ${index + 1}` }));
  const data = { remarksByAsin: { [ASINS[0]!]: remarks }, outcomesByAsin: {} };
  await pool.query(`INSERT INTO sync_job_stage_outputs
    (job_id,organization_id,project_id,run_id,stage_id,stage_status,content_hash,data_json,updated_at)
    VALUES ($1,$2,$3,$4,'image_remarks','done',$5,$6::jsonb,$7)
    ON CONFLICT (job_id,stage_id) DO UPDATE SET content_hash=EXCLUDED.content_hash,data_json=EXCLUDED.data_json,updated_at=EXCLUDED.updated_at`,
    [ids.jobId, ids.organizationId, ids.projectId, ids.runId, hash({ stage: "image_remarks", data }), JSON.stringify(data), NOW]);
}

async function seedAllOutputs(pool: Pool, ids: Awaited<ReturnType<typeof fixture>>["ids"]) {
  const gap = { state: "failed", reasonCode: "UPSTREAM_EMPTY" };
  for (const stage of OTHER_STAGES) {
    await pool.query(`INSERT INTO sync_job_stage_outputs
      (job_id,organization_id,project_id,run_id,stage_id,stage_status,content_hash,gap_json,updated_at)
      VALUES ($1,$2,$3,$4,$5,'failed',$6,$7::jsonb,$8)`,
      [ids.jobId, ids.organizationId, ids.projectId, ids.runId, stage, hash({ stage, gap }), JSON.stringify(gap), NOW]);
  }
  await imageOutput(pool, ids);
}

test("completed job publishes one scoped durable display version with persisted image remarks and explicit gaps", async () => {
  const { pool, ids, store } = await fixture();
  await imageOutput(pool, ids);
  const published = await store.publishFromCompletedJob({
    organizationId: ids.organizationId, projectId: ids.projectId, jobId: ids.jobId,
    expectedCurrentVersionId: null, publishedAt: NOW,
    catalog: [{ asin: ASINS[0], title: "Verified drift car" }],
  });
  const restored = await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId });
  assert.equal(restored?.versionId, published.versionId);
  assert.equal(restored?.jobId, ids.jobId);
  assert.equal(restored?.stageOutputs.image_remarks.stageStatus, "done");
  assert.ok(LocalDataStageOutputResponseSchema.safeParse(restored?.stageOutputs.image_remarks).success);
  assert.equal(((restored?.stageOutputs.image_remarks.data as Record<string, unknown>).remarksByAsin as Record<string, unknown[]>)[ASINS[0]!]?.length, 7);
  assert.ok(restored?.gaps.some(gap => gap.asin === ASINS[1] && gap.field === "image_remarks.remarksByAsin"));
  assert.ok(restored?.gaps.some(gap => gap.asin === ASINS[1] && gap.field === "catalog"));
  assert.deepEqual(restored?.catalog, [{ asin: ASINS[0], title: "Verified drift car" }]);
  assert.equal((await pool.query("SELECT current_display_version_id FROM projects WHERE id=$1", [ids.projectId])).rows[0]?.current_display_version_id, published.versionId);
});

test("a completed job with no usable stage data cannot replace the current report", async () => {
  const { pool, ids, store } = await fixture();
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null });
  const allFailed = await addJob(pool, ids, "2026-09-22T10:00:00.000Z");
  const gap = { state: "failed", reasonCode: "CONNECTOR_FAILED" };
  await pool.query(`UPDATE sync_job_stage_outputs SET stage_status='failed',data_json=NULL,
    gap_json=$2::jsonb,content_hash=$3 WHERE job_id=$1 AND stage_id='image_remarks'`,
  [allFailed.jobId, JSON.stringify(gap), hash({ stage: "image_remarks", gap })]);
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: allFailed.jobId, expectedCurrentVersionId: current.versionId }),
  /no usable stage data/);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);
});

async function addJob(pool: Pool, ids: Awaited<ReturnType<typeof fixture>>["ids"], completedAt: string, status: "completed" | "failed" = "completed", createdAt = completedAt) {
  const runId = randomUUID(), jobId = randomUUID();
  await pool.query(`INSERT INTO analysis_runs (id,project_id,mode,status,created_by,data_cutoff_at,idempotency_scope,idempotency_key,created_at,updated_at)
    VALUES ($1,$2,'existing-data','succeeded',$3,$4,$5,$6,$4,$4)`, [runId, ids.projectId, ids.actorId, completedAt, `sync:${ids.organizationId}:${ids.projectId}`, jobId]);
  await pool.query(`INSERT INTO sync_jobs (job_id,organization_id,project_id,run_id,actor_id,fingerprint,marketplace,asins,status,message,current_stage_id,stages,created_at,updated_at,completed_at,failed_at)
    VALUES ($1,$2,$3,$4,$5,$6,'US',$7::jsonb,$8,'done','done','[]'::jsonb,$9,$9,$10,$11)`,
    [jobId, ids.organizationId, ids.projectId, runId, ids.actorId, randomUUID(), JSON.stringify(ASINS), status, createdAt,
      status === "completed" ? completedAt : null, status === "failed" ? completedAt : null]);
  await seedAllOutputs(pool, { ...ids, runId, jobId });
  return { ...ids, runId, jobId };
}

test("failed and stale completed jobs cannot replace a published version", async () => {
  const { pool, ids, store } = await fixture();
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null, publishedAt: NOW });
  const failed = await addJob(pool, ids, "2026-09-22T10:00:00.000Z", "failed");
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: failed.jobId, expectedCurrentVersionId: current.versionId }), /Completed sync job/);
  const older = await addJob(pool, ids, "2026-09-20T10:00:00.000Z");
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: older.jobId, expectedCurrentVersionId: current.versionId }), StaleProjectDisplayCandidateError);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_display_versions WHERE project_id=$1", [ids.projectId])).rows[0]?.n, 1);
});

test("completed retry sharing a run can become current despite an older run idempotency key", async () => {
  const { pool, ids, store } = await fixture();
  const retryJobId = randomUUID();
  const completedAt = "2026-09-21T12:00:00.000Z";
  await pool.query(`INSERT INTO sync_jobs (job_id,organization_id,project_id,run_id,actor_id,fingerprint,marketplace,asins,status,message,current_stage_id,stages,created_at,updated_at,completed_at)
    VALUES ($1,$2,$3,$4,$5,$6,'US',$7::jsonb,'completed','done','done','[]'::jsonb,$8,$8,$8)`,
    [retryJobId, ids.organizationId, ids.projectId, ids.runId, ids.actorId, randomUUID(), JSON.stringify(ASINS), completedAt]);
  await seedAllOutputs(pool, { ...ids, jobId: retryJobId });
  const result = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: retryJobId, expectedCurrentVersionId: null, publishedAt: completedAt });
  assert.equal(result.jobId, retryJobId);
  assert.equal(result.runId, ids.runId);
  const imageStage = result.stageOutputs.image_remarks;
  if (imageStage.stageStatus === "missing-output") assert.fail("Retry image output was not persisted");
  assert.equal(((imageStage.data as Record<string, unknown>).remarksByAsin as Record<string, unknown[]>)[ASINS[0]!]?.length, 7);
});

test("an older-created job finishing late cannot replace a newer-created current job", async () => {
  const { pool, ids, store } = await fixture();
  const newer = await addJob(pool, ids, "2026-09-22T10:00:00.000Z");
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: newer.jobId, expectedCurrentVersionId: null });
  const lateOld = await addJob(pool, ids, "2026-09-23T10:00:00.000Z", "completed", "2026-09-20T10:00:00.000Z");
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: lateOld.jobId, expectedCurrentVersionId: current.versionId }), StaleProjectDisplayCandidateError);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);
});

test("a completed job missing one stage output cannot replace the current version", async () => {
  const { pool, ids, store } = await fixture();
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null });
  const incomplete = await addJob(pool, ids, "2026-09-22T10:00:00.000Z");
  await pool.query(`DELETE FROM sync_job_stage_outputs WHERE job_id=$1 AND stage_id='reviews'`, [incomplete.jobId]);
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: incomplete.jobId, expectedCurrentVersionId: current.versionId }), /all 10 stage outputs/);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);
});

test("CAS publication retains old body for 24 hours, then purges it and returns orphan image URLs", async () => {
  const { pool, ids, store } = await fixture();
  await imageOutput(pool, ids);
  const oldUrl = "https://m.media-amazon.com/images/I/old.jpg";
  const extensionlessUrl = "https://images.example.test/view?id=old";
  const sharedUrl = "https://m.media-amazon.com/images/I/shared.jpg";
  const first = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null, publishedAt: NOW,
    catalog: [{ asin: ASINS[0], image: oldUrl, secondaryImages: [extensionlessUrl] }, { asin: ASINS[1], image: sharedUrl }] });
  const secondJob = await addJob(pool, ids, "2026-09-22T10:00:00.000Z");
  await imageOutput(pool, secondJob);
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: secondJob.jobId, expectedCurrentVersionId: null,
    publishedAt: "2026-09-22T11:00:00.000Z" }), /Current display version changed/);
  const second = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: secondJob.jobId, expectedCurrentVersionId: first.versionId,
    publishedAt: "2026-09-22T11:00:00.000Z", catalog: [{ asin: ASINS[1], image: sharedUrl }] });
  assert.notEqual(second.versionId, first.versionId);
  assert.deepEqual(await store.cleanupExpiredBodies({ now: "2026-09-23T10:59:59.000Z" }), { purgedCount: 0, imageUrls: [] });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [ids.jobId])).rows[0]?.n, 10);
  assert.deepEqual(await store.cleanupExpiredBodies({ now: "2026-09-23T11:00:00.000Z" }), { purgedCount: 1, imageUrls: [extensionlessUrl, oldUrl] });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [ids.jobId])).rows[0]?.n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [secondJob.jobId])).rows[0]?.n, 10);
  const audit = (await pool.query(`SELECT content_hash,body_json,body_purged_at FROM project_display_versions WHERE id=$1`, [first.versionId])).rows[0];
  assert.equal(audit?.content_hash, first.contentHash);
  assert.equal(audit?.body_json, null);
  assert.ok(audit?.body_purged_at);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, second.versionId);
});

test("corrupt persisted stage output cannot publish and an outer transaction rollback keeps the old pointer", async () => {
  const { pool, ids, store } = await fixture();
  await imageOutput(pool, ids);
  await pool.query(`UPDATE sync_job_stage_outputs SET content_hash=$2 WHERE job_id=$1`, [ids.jobId, "0".repeat(64)]);
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null }), /hash mismatch/);
  assert.equal(await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }), null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_display_versions")).rows[0]?.n, 0);

  await pool.query("DELETE FROM sync_job_stage_outputs WHERE job_id=$1", [ids.jobId]);
  await seedAllOutputs(pool, ids);
  const context = new PostgresQueryContext(pool);
  const nested = new PostgresProjectDisplayVersionStore(context);
  await assert.rejects(context.transaction(async () => {
    await nested.publishFromCompletedJob({ organizationId: ids.organizationId,
      projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null });
    throw new Error("later completion failed");
  }), /later completion failed/);
  assert.equal(await nested.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }), null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_display_versions")).rows[0]?.n, 0);
});

test("publication rejects a foreign organization and an out-of-scope catalog record", async () => {
  const { ids, store } = await fixture();
  await assert.rejects(store.publishFromCompletedJob({ organizationId: randomUUID(),
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null }), /Project not found/);
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null,
    catalog: [{ asin: "B000000000", title: "Wrong product" }] }), /outside the project ASIN scope/);
  assert.equal(await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }), null);
});

test("a project with a display version remains deletable", async () => {
  const { pool, ids, store } = await fixture();
  await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null });
  await pool.query("DELETE FROM projects WHERE id=$1", [ids.projectId]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_display_versions WHERE project_id=$1", [ids.projectId])).rows[0]?.n, 0);
});
