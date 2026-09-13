import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { MarketResearchConflictError } from "../../server/db/market-research-repository";
import type { MarketOverviewReport, MarketResearchScope } from "../../shared/market-research-contracts";
import { startPostgresTestContainer } from "./helpers/postgres-test-container";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 12) + seconds * 1000).toISOString();
const scope: MarketResearchScope = { marketplace: "US", nodeQuery: "1063278", month: "2026-08", headTopN: 10, newProductMonths: 3 };
const report = (inputScope = scope): MarketOverviewReport => ({
  schemaVersion: "market-overview/v1", scope: inputScope, nodeId: "1063278", nodeIdPath: "228013:1063278", categoryName: "Floor Lamps", currency: "USD", collectedAt: at(2),
  metrics: { sampleProducts: 100, brands: 48, sellers: 60, totalUnits: 4567, totalRevenue: 150000, avgPrice: 40, avgUnits: null, avgRatings: null, avgRating: 4.2, productConcentrationRaw: null, brandConcentrationRaw: null, sellerConcentrationRaw: null, newCount: null, newAvgPrice: null, newAvgUnits: null },
  evidence: [{ dataset: "research", operation: "market_research", fetchedAt: at(2), contentHash: "a".repeat(64) }], issues: [], boundaries: ["Sample scope only"],
});

test("market research PostgreSQL store isolates organizations and fences durable job execution", { timeout: 90_000 }, async t => {
  const pg = await startPostgresTestContainer();
  t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const repository = new PostgresAgentRepository(pg.pool);
  assert.ok(repository.marketResearch, "PostgreSQL runtime must expose the market research store");
  const store = repository.marketResearch;
  const organizationId = randomUUID(), userId = randomUUID(), otherOrganizationId = randomUUID(), otherUserId = randomUUID();
  const actor = { organizationId, userId }, outsider = { organizationId: otherOrganizationId, userId: otherUserId };
  const observer = { organizationId, userId: randomUUID() };
  for (const item of [actor, outsider, observer]) await repository.createUser({ id: item.userId, organizationId: item.organizationId, email: `${item.userId}@example.com`, displayName: "Test", role: "member", status: "active", createdAt: at(0), updatedAt: at(0) });
  const firstInput = { ...actor, id: randomUUID(), idempotencyKey: randomUUID(), scope, now: at(0) };
  const secondInput = { ...actor, id: randomUUID(), idempotencyKey: randomUUID(), scope: { ...scope, month: "2026-07" }, now: at(0.1) };

  await t.test("creation replays only matching scope and hides another organization", async () => {
    const created = await store.create(firstInput);
    assert.equal(created.created, true);
    assert.equal(created.job.status, "queued");
    assert.equal(created.job.attempts, 0);
    assert.deepEqual(await store.create({ ...firstInput, id: randomUUID() }), { ...created, created: false });
    await assert.rejects(store.create({ ...firstInput, scope: { ...scope, month: "2026-06" } }), MarketResearchConflictError);
    await assert.rejects(store.create({ ...firstInput, idempotencyKey: randomUUID() }), MarketResearchConflictError);
    assert.equal(await store.find({ ...outsider, id: created.job.id }), null);
    assert.deepEqual(await store.list(outsider), []);
    assert.equal(await store.retry({ ...outsider, id: created.job.id, now: at(0) }), null);
    await assert.rejects(store.create({ ...firstInput, userId: otherUserId }), MarketResearchConflictError);
    assert.equal(await store.find({ ...actor, userId: otherUserId, id: created.job.id }), null);
    await store.create(secondInput);
  });

  let firstClaim: NonNullable<Awaited<ReturnType<typeof store.claim>>>;
  let secondClaim: NonNullable<Awaited<ReturnType<typeof store.claim>>>;
  await t.test("claim skips a locked queue row and never double-claims an active lease", async () => {
    const lock = await pg.pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM market_research_jobs WHERE id=$1 FOR UPDATE", [firstInput.id]);
      const claimed = await store.claim({ ownerId: "worker-b", now: at(0.2), leaseUntil: at(1) });
      assert.ok(claimed);
      assert.equal(claimed.job.id, secondInput.id);
      secondClaim = claimed;
    } finally { await lock.query("ROLLBACK"); lock.release(); }
    const claimed = await store.claim({ ownerId: "worker-a", now: at(0.2), leaseUntil: at(1) });
    assert.ok(claimed);
    assert.equal(claimed.job.id, firstInput.id);
    firstClaim = claimed;
    assert.equal(firstClaim.generation, 1);
    assert.equal(firstClaim.job.attempts, 1);
    assert.equal(await store.claim({ ownerId: "worker-c", now: at(0.3), leaseUntil: at(1) }), null);
  });

  await t.test("lease recovery rejects stale owners and successful reports are immutable", async () => {
    assert.equal(await store.renew({ claim: firstClaim, now: at(0.5), leaseUntil: at(2) }), true);
    assert.equal(await store.renew({ claim: { ...firstClaim, ownerId: "wrong-worker" }, now: at(0.6), leaseUntil: at(2) }), false);
    const replacement = await store.claim({ ownerId: "worker-new", now: at(1.1), leaseUntil: at(3) });
    assert.ok(replacement);
    assert.equal(replacement.job.id, secondInput.id);
    assert.equal(replacement.generation, secondClaim.generation + 1);
    assert.equal(replacement.job.attempts, 2);
    assert.equal(await store.renew({ claim: secondClaim, now: at(1.2), leaseUntil: at(4) }), false);
    assert.equal(await store.finish({ claim: secondClaim, now: at(2), report: report(secondInput.scope), error: null }), false);
    await assert.rejects(store.finish({ claim: replacement, now: at(2), report: report(), error: null }), MarketResearchConflictError);
    assert.equal(await store.finish({ claim: replacement, now: at(2), report: report(secondInput.scope), error: null }), true);
    assert.equal(await store.finish({ claim: replacement, now: at(2.1), report: report(secondInput.scope), error: null }), false);
    const saved = await store.find({ ...actor, id: secondInput.id });
    assert.equal(saved?.status, "succeeded");
    assert.deepEqual(saved?.report, report(secondInput.scope));
    await assert.rejects(pg.pool.query("UPDATE market_research_jobs SET report_json = jsonb_set(report_json, '{metrics,totalUnits}', '1') WHERE id=$1", [secondInput.id]));
    await assert.rejects(pg.pool.query("DELETE FROM market_research_jobs WHERE id=$1", [secondInput.id]));
    await assert.rejects(store.retry({ ...actor, id: secondInput.id, now: at(3) }), MarketResearchConflictError);
  });

  await t.test("expired third attempts become failed and cannot exceed the retry cap", async () => {
    for (const [second, attempts] of [[3, 2], [5, 3]] as const) {
      const claimed = await store.claim({ ownerId: `recovery-${attempts}`, now: at(second), leaseUntil: at(second + 1) });
      assert.ok(claimed);
      assert.equal(claimed.job.id, firstInput.id);
      assert.equal(claimed.job.attempts, attempts);
    }
    assert.equal(await store.claim({ ownerId: "recovery-4", now: at(7), leaseUntil: at(8) }), null);
    const exhausted = await store.find({ ...actor, id: firstInput.id });
    assert.equal(exhausted?.status, "failed");
    assert.equal(exhausted?.attempts, 3);
    assert.equal(exhausted?.error?.code, "interrupted");
    assert.equal(exhausted?.error?.retryable, false);
    await assert.rejects(store.retry({ ...actor, id: firstInput.id, now: at(8) }), MarketResearchConflictError);
  });

  await t.test("explicit retry keeps attempts cumulative and refuses nonretryable failure", async () => {
    const input = { ...actor, id: randomUUID(), idempotencyKey: randomUUID(), scope, now: at(9) };
    await store.create(input);
    const claimed = await store.claim({ ownerId: "worker-retry", now: at(9), leaseUntil: at(12) });
    assert.ok(claimed);
    assert.equal(await store.finish({ claim: claimed, now: at(10), report: null, error: { dataset: "research", code: "timeout", message: "Upstream timeout", retryable: true } }), true);
    assert.equal((await store.retry({ ...actor, id: input.id, now: at(10) }))?.status, "queued");
    const next = await store.claim({ ownerId: "worker-retry", now: at(10), leaseUntil: at(12) });
    assert.ok(next);
    assert.equal(next.job.attempts, 2);
    assert.equal(await store.finish({ claim: next, now: at(11), report: null, error: { dataset: "research", code: "scope-mismatch", message: "Wrong scope", retryable: false } }), true);
    await assert.rejects(store.retry({ ...actor, id: input.id, now: at(11) }), MarketResearchConflictError);
  });

  await t.test("actor revocation blocks execution and clears queued or expired work without reviving a lease", async st => {
    st.after(() => pg.pool.query("UPDATE users SET status='active' WHERE id=$1", [userId]));
    const input = { ...actor, id: randomUUID(), idempotencyKey: randomUUID(), scope, now: at(13) };
    await store.create(input);
    await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [userId]);
    assert.equal(await store.claim({ ownerId: "revoked-worker", now: at(13), leaseUntil: at(16) }), null);
    assert.equal(await store.find({ ...actor, id: input.id }), null);
    assert.deepEqual(await store.list(actor), []);
    const revokedQueued = await store.find({ ...observer, id: input.id });
    assert.equal(revokedQueued?.status, "failed");
    assert.equal(revokedQueued?.attempts, 0);
    assert.equal(revokedQueued?.error?.code, "authentication");
    assert.equal(revokedQueued?.error?.retryable, true);
    await assert.rejects(store.retry({ ...observer, id: input.id, now: at(13) }), MarketResearchConflictError);
    await assert.rejects(store.create({ ...input, id: randomUUID(), idempotencyKey: randomUUID() }), MarketResearchConflictError);
    await pg.pool.query("UPDATE users SET status='active' WHERE id=$1", [userId]);
    assert.equal((await store.retry({ ...actor, id: input.id, now: at(13) }))?.status, "queued");
    const claimed = await store.claim({ ownerId: "revoked-worker", now: at(13), leaseUntil: at(16) });
    assert.ok(claimed);
    await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [userId]);
    assert.equal(await store.renew({ claim: claimed, now: at(14), leaseUntil: at(17) }), false);
    assert.equal(await store.finish({ claim: claimed, now: at(14), report: report(), error: null }), false);
    assert.equal(await store.claim({ ownerId: "cleanup-worker", now: at(14), leaseUntil: at(17) }), null);
    assert.equal((await store.find({ ...observer, id: input.id }))?.status, "running");
    assert.equal(await store.claim({ ownerId: "cleanup-worker", now: at(17), leaseUntil: at(19) }), null);
    const revokedRunning = await store.find({ ...observer, id: input.id });
    assert.equal(revokedRunning?.status, "failed");
    assert.equal(revokedRunning?.attempts, 1);
    assert.equal(revokedRunning?.error?.code, "authentication");
    assert.equal(revokedRunning?.error?.retryable, true);
    await assert.rejects(store.retry({ ...observer, id: input.id, now: at(17) }), MarketResearchConflictError);
    await pg.pool.query("UPDATE users SET status='active' WHERE id=$1", [userId]);
    assert.equal((await store.retry({ ...actor, id: input.id, now: at(17) }))?.status, "queued");
    const recovered = await store.claim({ ownerId: "recovered-worker", now: at(17), leaseUntil: at(20) });
    assert.ok(recovered);
    assert.equal(recovered.job.attempts, 2);
    const partial = report();
    partial.issues = [{ dataset: "statistics", code: "empty", message: "No statistics", retryable: true }];
    assert.equal(await store.finish({ claim: claimed, now: at(18), report: partial, error: null }), false);
    assert.equal(await store.finish({ claim: recovered, now: at(18), report: partial, error: null }), true);
    assert.equal((await store.find({ ...actor, id: input.id }))?.status, "partial");
  });

  await t.test("history returns the latest 30 organization jobs and immutable input cannot change", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 31; index++) {
      const id = randomUUID(); ids.push(id);
      await store.create({ ...actor, id, idempotencyKey: randomUUID(), scope, now: at(100 + index) });
    }
    assert.deepEqual((await store.list(actor)).map(item => item.id), ids.slice(1).reverse());
    assert.deepEqual(await store.list(outsider), []);
    await assert.rejects(pg.pool.query("UPDATE market_research_jobs SET organization_id=$1 WHERE id=$2", [otherOrganizationId, ids[0]]));
    await assert.rejects(pg.pool.query("UPDATE market_research_jobs SET scope_json=jsonb_set(scope_json,'{month}','\"2026-01\"') WHERE id=$1", [ids[0]]));
  });
});
