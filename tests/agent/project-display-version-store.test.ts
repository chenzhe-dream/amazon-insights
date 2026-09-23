import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { reviseProjectDisplayCatalog } from "../../scripts/revise-project-display-catalog";

import { LocalDataStageOutputResponseSchema } from "../../shared/agent-contracts";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresProjectDisplayVersionStore, StaleProjectDisplayCandidateError } from "../../server/db/postgres/project-display-version-store";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
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

async function replaceDoneOutput(pool: Pool, ids: Awaited<ReturnType<typeof fixture>>["ids"], stage: string, data: unknown) {
  const result = await pool.query(`UPDATE sync_job_stage_outputs SET stage_status='done',data_json=$3::jsonb,
    gap_json=NULL,content_hash=$4 WHERE job_id=$1 AND stage_id=$2`,
  [ids.jobId, stage, JSON.stringify(data), hash({ stage, data })]);
  assert.equal(result.rowCount, 1);
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

test("a same-URL image remark cannot disappear when a newer candidate is published", async () => {
  const { pool, ids, store } = await fixture();
  const asin = ASINS[0]!;
  const gallery = ["https://example.test/main.jpg", "https://example.test/secondary.jpg"];
  const listing = (urls: string[]) => ({ contentByAsin: { [asin]: {
    status: "ready", mainImage: urls[0], galleryImages: urls,
    secondaryImages: urls.slice(1), imageCount: urls.length,
  } } });
  const notes = (urls: string[], secondRemark = "Verified secondary") => ({ remarksByAsin: { [asin]: [
    { imageUrl: urls[0], remark: "Verified main", image_types: ["main"] },
    { imageUrl: urls[1], remark: secondRemark, image_types: ["secondary"] },
  ] }, outcomesByAsin: {} });
  await replaceDoneOutput(pool, ids, "listing", listing(gallery));
  await replaceDoneOutput(pool, ids, "image_remarks", notes(gallery));
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null });

  const losing = await addJob(pool, ids, "2026-09-22T10:00:00.000Z");
  await replaceDoneOutput(pool, losing, "listing", listing(gallery));
  await replaceDoneOutput(pool, losing, "image_remarks", notes(gallery, ""));
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: losing.jobId, expectedCurrentVersionId: current.versionId }),
  /Candidate would lose verified data: image_remarks/);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);

  const reordered = await addJob(pool, ids, "2026-09-23T10:00:00.000Z");
  await replaceDoneOutput(pool, reordered, "listing", listing([...gallery].reverse()));
  await replaceDoneOutput(pool, reordered, "image_remarks", notes([...gallery].reverse()));
  const next = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: reordered.jobId, expectedCurrentVersionId: current.versionId });
  assert.equal(next.jobId, reordered.jobId, "a fully remarked gallery may be reordered");
});

test("a partial gallery may reorder while its verified remark follows the image URL", async () => {
  const { pool, ids, store } = await fixture();
  const asin = ASINS[0]!;
  const main = "https://example.test/verified-main.jpg";
  const secondary = "https://example.test/unremarked-secondary.jpg";
  const listing = (urls: string[]) => ({ contentByAsin: { [asin]: {
    status: "ready", mainImage: urls[0], galleryImages: urls,
    secondaryImages: urls.slice(1), imageCount: urls.length,
  } } });
  const remark = { imageUrl: main, remark: "Verified main", image_types: ["main"] };
  await replaceDoneOutput(pool, ids, "listing", listing([main, secondary]));
  await replaceDoneOutput(pool, ids, "image_remarks", { remarksByAsin: { [asin]: [remark, null] }, outcomesByAsin: {} });
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null });

  const reordered = await addJob(pool, ids, "2026-09-23T10:00:00.000Z");
  await replaceDoneOutput(pool, reordered, "listing", listing([secondary, main]));
  await replaceDoneOutput(pool, reordered, "image_remarks", { remarksByAsin: { [asin]: [null, remark] }, outcomesByAsin: {} });
  const next = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: reordered.jobId, expectedCurrentVersionId: current.versionId });
  assert.equal(next.jobId, reordered.jobId);
});

test("a partial result cannot replace an existing successful ASIN field with null", async () => {
  const { pool, ids, store } = await fixture();
  const asin = ASINS[0]!;
  const reviews = (rating: number | null) => ({ analysisByAsin: { [asin]: { summary: "Verified review" } },
    ratingByAsin: { [asin]: { rating, reviewCount: 100 } } });
  await replaceDoneOutput(pool, ids, "reviews", reviews(4.6));
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null });
  const losing = await addJob(pool, ids, "2026-09-22T10:00:00.000Z");
  await replaceDoneOutput(pool, losing, "reviews", reviews(null));
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: losing.jobId, expectedCurrentVersionId: current.versionId }),
  /Candidate would lose verified data: reviews.ratingByAsin/);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);

  const failedStage = await addJob(pool, ids, "2026-09-22T11:00:00.000Z");
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: failedStage.jobId, expectedCurrentVersionId: current.versionId }),
  /Candidate would lose verified data: reviews.analysisByAsin/);

  const refreshed = await addJob(pool, ids, "2026-09-23T10:00:00.000Z");
  await replaceDoneOutput(pool, refreshed, "reviews", reviews(4.8));
  const next = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: refreshed.jobId, expectedCurrentVersionId: current.versionId });
  assert.equal(next.jobId, refreshed.jobId);
  const reviewStage = next.stageOutputs.reviews;
  assert.notEqual(reviewStage.stageStatus, "missing-output");
  if (reviewStage.stageStatus === "missing-output") assert.fail("review stage missing");
  assert.equal(((reviewStage.data as Record<string, unknown>).ratingByAsin as Record<string, { rating: number }>)[asin]?.rating, 4.8);
});

test("a verified catalog field cannot regress to an upstream null", async () => {
  const { pool, ids, store } = await fixture();
  const asin = ASINS[0]!;
  const product = (price: number | null) => [{ asin, catalogSource: "sellerSprite", synced: true,
    brand: "Verified brand", title: "Verified title", price }];
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null, catalog: product(99) });
  const losing = await addJob(pool, ids, "2026-09-22T10:00:00.000Z");
  await assert.rejects(store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: losing.jobId, expectedCurrentVersionId: current.versionId, catalog: product(null) }),
  /Candidate would lose verified data: catalog.*price/);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);
  const improved = await addJob(pool, ids, "2026-09-23T10:00:00.000Z");
  const next = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: improved.jobId, expectedCurrentVersionId: current.versionId, catalog: product(95) });
  assert.equal(next.catalog[0]?.price, 95);
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

test("catalog revision creates an audited immutable version and keeps shared job outputs after old body expiry", async () => {
  const { pool, ids, store } = await fixture();
  const first = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null, publishedAt: NOW });
  const sourceJob = await addJob(pool, ids, "2026-09-23T05:50:00.000Z", "completed", "2026-09-23T05:40:00.000Z");
  const evidence = { sourceKind: "generated-file" as const,
    sourceRef: "app/competitor-data.ts#refreshedCatalog" as const, sourceSha256: "a".repeat(64),
    sourceUpdatedAt: "2026-09-23T05:44:00.000Z", capturedAt: "2026-09-23T12:00:00.000Z",
    sourceJobId: sourceJob.jobId };
  const revised = await store.reviseCurrentCatalog({ organizationId: ids.organizationId,
    projectId: ids.projectId, expectedCurrentVersionId: first.versionId,
    publishedAt: "2026-09-23T12:00:00.000Z", evidence,
    catalog: [{ asin: ASINS[0], catalogSource: "sellerSprite", synced: true, brand: "Verified brand", title: "Verified title", price: 99 },
      { asin: ASINS[1], catalogSource: "sorftime-fallback", synced: false, brand: null, title: "Partial title",
        price: null, sales: null, rating: null, reviews: null, image: null }] });
  assert.notEqual(revised.versionId, first.versionId);
  assert.equal(revised.jobId, first.jobId);
  assert.deepEqual(revised.stageOutputs, first.stageOutputs);
  assert.equal(revised.catalog[1]?.price, null);
  for (const field of ["catalog.sellerSprite", "catalog.brand", "catalog.price", "catalog.sales", "catalog.rating", "catalog.reviews", "catalog.image"]) {
    assert.ok(revised.gaps.some(gap => gap.asin === ASINS[1] && gap.field === field), field);
  }
  assert.equal(revised.catalogEvidence?.sourceJobId, sourceJob.jobId);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, revised.versionId);
  await assert.rejects(store.reviseCurrentCatalog({ organizationId: ids.organizationId,
    projectId: ids.projectId, expectedCurrentVersionId: revised.versionId,
    publishedAt: "2026-09-23T12:01:00.000Z", evidence: { ...evidence, capturedAt: "2026-09-23T12:01:00.000Z" },
    catalog: revised.catalog.map((item, index) => index === 0 ? { ...item, price: null } : item) }),
  /Candidate would lose verified data: catalog.*price/);
  await assert.rejects(store.reviseCurrentCatalog({ organizationId: ids.organizationId,
    projectId: ids.projectId, expectedCurrentVersionId: first.versionId, evidence, catalog: [] }), /Current display version changed/);
  const oldAudit = (await pool.query(`SELECT revision_kind,supersedes_version_id,body_expires_at FROM project_display_versions WHERE id=$1`, [first.versionId])).rows[0];
  assert.equal(oldAudit?.revision_kind, "job-publication");
  assert.equal(new Date(oldAudit.body_expires_at).toISOString(), "2026-09-24T12:00:00.000Z");
  const revisedAudit = (await pool.query(`SELECT revision_kind,supersedes_version_id,catalog_evidence_json FROM project_display_versions WHERE id=$1`, [revised.versionId])).rows[0];
  assert.equal(revisedAudit?.revision_kind, "catalog-revision");
  assert.equal(revisedAudit?.supersedes_version_id, first.versionId);
  assert.equal(revisedAudit?.catalog_evidence_json.sourceSha256, evidence.sourceSha256);
  assert.deepEqual(await store.cleanupExpiredBodies({ now: "2026-09-24T12:00:00.000Z" }), { purgedCount: 1, imageUrls: [] });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [ids.jobId])).rows[0]?.n, 10);
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, revised.versionId);
});

test("unversioned completed outputs expire after the first project publication without resetting on catalog revision", async () => {
  const { pool, ids, store } = await fixture();
  const stageStore = new PostgresSyncJobStore(new PostgresQueryContext(pool));
  const now = new Date();
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
  const historical = await addJob(pool, ids, at(48));
  const markReadable = async (jobId: string) => pool.query(`UPDATE sync_jobs SET stages=$2::jsonb WHERE job_id=$1`,
    [jobId, JSON.stringify([{ id: "image_remarks", status: "done", label: "Images", kind: "auto", estimatedSeconds: 1 }])]);
  const readImage = (jobId: string, runId: string) => stageStore.readStageOutput({ organizationId: ids.organizationId,
    projectId: ids.projectId, runId, jobId, stage: "image_remarks" });
  await markReadable(historical.jobId);
  assert.ok(await readImage(historical.jobId, historical.runId));
  await store.cleanupExpiredBodies({ now: now.toISOString() });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [historical.jobId])).rows[0]?.n, 10,
    "a project without a current version retains recovery evidence");

  const published = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null, publishedAt: at(25) });
  const revised = await store.reviseCurrentCatalog({ organizationId: ids.organizationId,
    projectId: ids.projectId, expectedCurrentVersionId: published.versionId, publishedAt: at(1), catalog: [],
    evidence: { sourceKind: "generated-file", sourceRef: "app/competitor-data.ts#refreshedCatalog",
      sourceSha256: "d".repeat(64), sourceUpdatedAt: at(2), capturedAt: at(1) } });
  assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, revised.versionId);
  assert.equal(await readImage(historical.jobId, historical.runId), null,
    "a catalog revision cannot reopen the first publication rollback window");

  const recent = await addJob(pool, ids, at(1));
  await markReadable(recent.jobId);
  assert.ok(await readImage(recent.jobId, recent.runId), "a new unversioned result retains its own 24-hour diagnostic window");
  await store.cleanupExpiredBodies({ now: now.toISOString() });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [historical.jobId])).rows[0]?.n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [recent.jobId])).rows[0]?.n, 10);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [ids.jobId])).rows[0]?.n, 10,
    "current-version source rows remain untouched");
});

test("catalog recovery CLI previews exact 8 ASIN provenance and requires reviewed file hash to apply", async () => {
  const { pool, ids, store } = await fixture();
  const current = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null, publishedAt: NOW });
  const sourceJob = await addJob(pool, ids, "2026-09-23T05:50:00.000Z", "completed", "2026-09-23T05:40:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "catalog-revision-cli-"));
  try {
    const catalogPath = path.join(directory, "competitor-data.ts");
    const catalog = ASINS.map((asin, index) => index < 4
      ? { asin, catalogSource: "sellerSprite", synced: true, brand: `Brand ${index}`, title: `Title ${index}`, price: 99 }
      : { asin, catalogSource: "sorftime-fallback", synced: false, brand: null, title: `Fallback ${index}`,
        price: null, sales: null, rating: null, reviews: null });
    await writeFile(catalogPath, `export const refreshedCatalog = ${JSON.stringify(catalog)};\n`);
    await utimes(catalogPath, new Date("2026-09-23T05:44:00.000Z"), new Date("2026-09-23T05:44:00.000Z"));
    const args = ["--organization-id", ids.organizationId, "--project-id", ids.projectId,
      "--expected-version-id", current.versionId, "--catalog-path", catalogPath,
      "--source-job-id", sourceJob.jobId];
    const preview = await reviseProjectDisplayCatalog(args, {}, pool);
    assert.deepEqual(preview.counts, { sellerSpriteSynced: 4, unverified: 4, absent: 0 });
    assert.equal(preview.mode, "dry-run");
    assert.equal((await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId }))?.versionId, current.versionId);
    await assert.rejects(reviseProjectDisplayCatalog([...args, "--apply"], {}, pool), /requires --expected-source-sha256/);
    const result = await reviseProjectDisplayCatalog([...args, "--expected-source-sha256", preview.sourceSha256, "--apply"], {}, pool);
    assert.equal(result.mode, "applied");
    const revised = await store.readCurrent({ organizationId: ids.organizationId, projectId: ids.projectId });
    assert.notEqual(revised?.versionId, current.versionId);
    assert.equal(revised?.catalog.length, 8);
    assert.equal(revised?.catalog[4]?.price, null);
    assert.equal(revised?.gaps.filter(gap => gap.field === "catalog.sellerSprite").length, 4);
    assert.equal(revised?.catalogEvidence?.sourceJobId, sourceJob.jobId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired retired stage outputs are unreadable before the retention sweep deletes them", async () => {
  const { pool, ids, store } = await fixture();
  await pool.query(`UPDATE sync_jobs SET stages=$2::jsonb WHERE job_id=$1`,
    [ids.jobId, JSON.stringify([{ id: "image_remarks", status: "done" }])]);
  const first = await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: ids.jobId, expectedCurrentVersionId: null, publishedAt: NOW });
  const reader = new PostgresSyncJobStore(new PostgresQueryContext(pool));
  const scope = { organizationId: ids.organizationId, projectId: ids.projectId, runId: ids.runId,
    jobId: ids.jobId, stage: "image_remarks" as const };
  assert.equal((await reader.readStageOutput(scope))?.stageStatus, "done");
  const next = await addJob(pool, ids, "2026-09-24T10:00:00.000Z");
  await store.publishFromCompletedJob({ organizationId: ids.organizationId,
    projectId: ids.projectId, jobId: next.jobId, expectedCurrentVersionId: first.versionId });
  await pool.query(`UPDATE project_display_versions SET body_expires_at=now() - interval '1 second' WHERE id=$1`, [first.versionId]);
  assert.equal(await reader.readStageOutput(scope), null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_job_stage_outputs WHERE job_id=$1`, [ids.jobId])).rows[0]?.n, 10);
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
