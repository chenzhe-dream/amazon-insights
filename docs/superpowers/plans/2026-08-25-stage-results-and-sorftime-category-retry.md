# Stage Results and Sorftime Category Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each persisted sync module visible before the final Web build while giving only Sorftime category one governed automatic retry for `CONNECT_TIMEOUT`.

**Architecture:** Slice A adds a canonical PostgreSQL stage-output projection, a scope-checked read API, and a browser overlay driven by the existing job poll; the final artifact is reconciled against the same persisted hashes. Slice B retries the failed physical category request once inside the Sorftime client, records both governed attempts, fails closed after the second timeout, and reuses the original job for explicit category-only resume. The slices remain independently reviewable and are released through one combined acceptance gate.

**Tech Stack:** Node.js >= 22.13.0, TypeScript 5.9.3, React 19.2.6, Fastify 5.12, Zod 4.4.3, PostgreSQL/pg 8.23, and the existing Node test runner through tsx with its DOM/browser harness.

## Global Constraints

- Keep the existing 1.5-second `GET /v1/local-data/sync-asins/:jobId` poll; add no second timer, SSE, WebSocket, provider probe, per-stage build, per-stage reload, or new start mechanism.
- Add exactly `GET /v1/projects/:projectId/runs/:runId/sync-jobs/:jobId/stages/:stage/output` for canonical project/run jobs; legacy or unscoped jobs retain their existing fallback.
- Derive `organizationId` only from the authenticated Agent session. Path IDs are selectors and never authorization claims.
- Require exact organization/project/run/job/stage/output ownership matches and use the existing existence-indistinguishable `404 NOT_FOUND` behavior for every mismatch.
- Expose only `keywords`, `reviews`, `sales_trend`, `fba`, `listing`, `category`, and `traffic`; `sales_trend` remains the runner stage that supplies the sales UI module.
- A projectable stage becomes `done`, `partial`, or `failed` only in the same repository transaction that persists its normalized output or fixed gap.
- Cache by `(session organizationId, projectId, runId, jobId, stage, contentHash)` and bind the value to monotonic `jobVersion` and `outputVersion`; discard scope mismatch, older versions, and hash mismatch.
- Preserve already verified module data across another stage failure, `completed-with-gaps`, publication pending/failed, and transient poll failures; clear memory references on logout, URL scope change, or job switch.
- The runner performs one final full build/publication request, and the supervisor remains the only Web publisher.
- Sorftime category alone gets at most one automatic retry, and only when the first physical request is classified as `CONNECT_TIMEOUT`.
- Every initial, repair, and `transient-retry` physical request obtains its own Sorftime governor permit and records exactly one `concurrency_physical_attempts` row immediately before dispatch.
- After the second category `CONNECT_TIMEOUT`, issue no third physical dispatch for that work item and stop all not-yet-issued category requests; SellerSprite and SIF behavior is unchanged.
- Explicit resume resets only category work in the original job; it creates zero sync jobs, analysis runs, run stages, or unrelated work items, retains the attempt trail, and requires no active Worker.
- Do not add dependencies or expose source paths, raw provider bodies, credentials, free-text transport diagnostics, or internal launcher/lease fields.

---

## File Structure and Interfaces

| Area | File | Responsibility |
|---|---|---|
| Shared contract | `shared/agent-contracts.ts` | Stage names, strict projection response, job version, and API registry entry |
| Stage-output storage | `server/db/migrations/postgres/0016_sync_stage_outputs.sql` | Canonical output rows and monotonic versions |
| Persistence port | `server/db/sync-job-repository.ts` | Output draft/read types and repository methods |
| PostgreSQL adapter | `server/db/postgres/sync-job-store.ts` | Atomic terminal-stage/output upsert and exact scoped read |
| Runner projection | `scripts/lib/sync-stage-output.mjs` | Read only normalized generated module exports and calculate canonical hashes |
| Mirror ingestion | `server/services/sync-job-worker-handler.ts` | Validate mirror output drafts and pass them into fenced progress writes |
| API | `server/services/sync-job-service.ts`, `server/routes/local-data.ts` | Exact scoped lookup and read-only route |
| Browser overlay | `app/lib/stage-output-browser.ts`, `app/asin-sync-funnel.tsx`, `app/page.tsx` | Observe terminal transitions, fetch once per version, cache, and locally render |
| Module consumers | `app/keyword-fetch-status.tsx`, `app/keyword-demand-analysis.ts`, `app/category-node-trend-section.tsx`, `app/listing-images-section.tsx`, `app/listing-aplus-section.tsx` | Accept stage overlay data instead of requiring a reload |
| Publication | `scripts/lib/web-artifact-store.mjs`, `scripts/run-asin-sync-job.mjs`, `scripts/lib/web-reload-request.mjs`, `server/services/sync-publication-status-service.ts` | Bind artifact/job version and displayed content hashes |
| Retry storage | `server/db/migrations/postgres/0017_category_transient_retry.sql` | Permit/attempt metadata and `transient-retry` constraint |
| Retry dispatch | `scripts/lib/postgres-resource-governor.mjs`, `scripts/lib/sorftime-mcp-client.mjs` | One permit/attempt per dispatch and bounded category retry |
| Category closure/resume | `scripts/build-sorftime-category-trend.mjs`, `scripts/run-asin-sync-job.mjs`, `server/db/postgres/sync-job-store.ts` | Sequential fail-closed category execution and original-job resume |

The persisted `data` keys are fixed as follows; no projector may copy an arbitrary provider object or filesystem path:

| Stage | Persisted data keys | Existing normalized source exports |
|---|---|---|
| `keywords` | `analysisByAsin`, `enrichmentByKeyword` | `sifKeywordAnalysisData`, `sifKeywordEnrichmentData` |
| `reviews` | `analysisByAsin`, `ratingByAsin` | `sorftimeReviewAnalysisData`, `sorftimeRatingData` |
| `sales_trend` | `trendByAsin` | `sorftimeSalesTrendData` |
| `fba` | `feeByAsin` | `sorftimeFbaFeeData` |
| `listing` | `contentByAsin` | `sorftimeListingContentData` |
| `category` | `trendByNode` | `sorftimeCategoryTrendData` |
| `traffic` | `listingByAsin`, `monthlyByAsin` | `sifListingTrafficRawByAsin`, `sifMonthlyTrafficRawByAsin` |

## Task Group A: Stage-output incremental display

### Task 1: Define the strict contract and canonical PostgreSQL output table

**Files:**
- Create: `server/db/migrations/postgres/0016_sync_stage_outputs.sql`
- Create: `tests/agent/stage-output-contract.test.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `app/lib/sync-server.ts`
- Modify: `tests/agent/postgres-migrations.test.ts`
- Modify: `tests/agent/agent-api-schema.test.ts`

**Interfaces:**
- Produces: `ProjectableSyncStage`, `StageOutputProjection`, `StageOutputDraft`, `LocalDataStageOutputResponseSchema`, and `SyncJob.jobVersion: number`.
- Produces table: `sync_job_stage_outputs(job_id, organization_id, project_id, run_id, stage_id, stage_status, output_version, content_hash, data_json, gap_json, updated_at)`.

- [ ] **Step 1: Write failing contract and migration tests**

```ts
test("stage output accepts one normalized data branch and rejects mixed or unknown fields", () => {
  const valid = stageProjection({
    stage: "sales_trend",
    data: { trendByAsin: { B0TEST0001: { status: "ready", volume: [] } } },
  });
  assert.equal(LocalDataStageOutputResponseSchema.safeParse(valid).success, true);
  assert.equal(LocalDataStageOutputResponseSchema.safeParse({
    ...valid,
    gap: { state: "failed", reasonCode: "CONNECT_TIMEOUT" },
  }).success, false);
  assert.equal(LocalDataStageOutputResponseSchema.safeParse({
    ...valid,
    sourcePath: "app/sorftime-sales-trend-data.ts",
  }).success, false);
});

test("fresh PostgreSQL schema includes canonical stage outputs and job versions", async () => {
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('sync_jobs', 'sync_job_stage_outputs')
       ORDER BY table_name, ordinal_position`,
  );
  assert.ok(columns.rows.some(row => row.column_name === "job_version"));
  assert.ok(columns.rows.some(row => row.column_name === "output_version"));
});
```

- [ ] **Step 2: Run the RED tests**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/postgres-migrations.test.ts tests/agent/agent-api-schema.test.ts`

Expected: FAIL because the stage-output schema, API entry, `jobVersion`, migration 0016, and output table do not exist.

- [ ] **Step 3: Add the minimal strict contract and migration**

```ts
export const ProjectableSyncStageSchema = z.enum([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
]);
export type ProjectableSyncStage = z.infer<typeof ProjectableSyncStageSchema>;

export const StageOutputGapSchema = strictObject({
  state: z.enum(["partial", "failed"]),
  reasonCode: z.enum(["CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED"]),
});

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));
const JsonMapSchema = z.record(z.string(), JsonValueSchema);
const StageDataSchemas = {
  keywords: strictObject({ analysisByAsin: JsonMapSchema, enrichmentByKeyword: JsonMapSchema }),
  reviews: strictObject({ analysisByAsin: JsonMapSchema, ratingByAsin: JsonMapSchema }),
  sales_trend: strictObject({ trendByAsin: JsonMapSchema }),
  fba: strictObject({ feeByAsin: JsonMapSchema }),
  listing: strictObject({ contentByAsin: JsonMapSchema }),
  category: strictObject({ trendByNode: JsonMapSchema }),
  traffic: strictObject({ listingByAsin: JsonMapSchema, monthlyByAsin: JsonMapSchema }),
} as const;
const ProjectionBase = {
  jobId: z.string().min(1).max(200), projectId: EntityIdSchema, runId: EntityIdSchema,
  jobVersion: z.number().int().positive(), outputVersion: z.number().int().positive(),
  contentHash: Sha256Schema, updatedAt: DateTimeSchema,
};
const dataProjection = <S extends ProjectableSyncStage>(stage: S) => strictObject({
  ...ProjectionBase, stage: z.literal(stage), stageStatus: z.literal("done"), data: StageDataSchemas[stage],
});
const gapProjection = <S extends ProjectableSyncStage>(stage: S) => strictObject({
  ...ProjectionBase, stage: z.literal(stage), stageStatus: z.enum(["partial", "failed"]), gap: StageOutputGapSchema,
});
export const LocalDataStageOutputResponseSchema = z.union([
  dataProjection("keywords"), gapProjection("keywords"),
  dataProjection("reviews"), gapProjection("reviews"),
  dataProjection("sales_trend"), gapProjection("sales_trend"),
  dataProjection("fba"), gapProjection("fba"),
  dataProjection("listing"), gapProjection("listing"),
  dataProjection("category"), gapProjection("category"),
  dataProjection("traffic"), gapProjection("traffic"),
]);
export type StageOutputProjection = z.infer<typeof LocalDataStageOutputResponseSchema>;

export const LocalDataStageOutputParamsSchema = strictObject({
  projectId: EntityIdSchema, runId: EntityIdSchema,
  jobId: z.string().trim().min(1).max(200), stage: ProjectableSyncStageSchema,
});
```

Migration requirements:

```sql
ALTER TABLE sync_jobs ADD COLUMN job_version BIGINT NOT NULL DEFAULT 1 CHECK (job_version > 0);

CREATE TABLE sync_job_stage_outputs (
  job_id TEXT NOT NULL REFERENCES sync_jobs (job_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL CHECK (stage_id IN ('keywords','reviews','sales_trend','fba','listing','category','traffic')),
  stage_status TEXT NOT NULL CHECK (stage_status IN ('done','partial','failed')),
  output_version BIGINT NOT NULL DEFAULT 1 CHECK (output_version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  data_json JSONB,
  gap_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, stage_id),
  CHECK ((data_json IS NOT NULL)::integer + (gap_json IS NOT NULL)::integer = 1)
);

CREATE INDEX sync_job_stage_outputs_scope_idx
ON sync_job_stage_outputs (organization_id, project_id, run_id, job_id, stage_id);
```

Add the route registry entry and update the fresh-migration assertions from 15 to 16. Extend `SyncJob` and `LocalDataSyncJobPublicSchema` with positive integer `jobVersion`.

- [ ] **Step 4: Run the GREEN tests**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/postgres-migrations.test.ts tests/agent/agent-api-schema.test.ts`

Expected: PASS; strict unions reject mixed branches/internal fields and a fresh database reports 16 migrations.

- [ ] **Step 5: Commit**

```bash
git add shared/agent-contracts.ts app/lib/sync-server.ts server/db/migrations/postgres/0016_sync_stage_outputs.sql tests/agent/stage-output-contract.test.ts tests/agent/postgres-migrations.test.ts tests/agent/agent-api-schema.test.ts
git commit -m "feat: define scoped stage output contract"
```

### Task 2: Persist terminal stage projections atomically

**Files:**
- Create: `scripts/lib/sync-stage-output.mjs`
- Create: `tests/scripts/sync-stage-output.test.mjs`
- Create: `tests/agent/sync-stage-output-persistence.test.ts`
- Modify: `server/db/sync-job-repository.ts`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/services/sync-job-worker-handler.ts`
- Modify: `scripts/lib/sync-job-store.mjs`
- Modify: `scripts/run-asin-sync-job.mjs`

**Interfaces:**
- Produces: `projectStageOutput(stageId, asins, options): StageOutputDraft` in the runner.
- Produces: `SyncJobRepository.readStageOutput(input): Promise<StageOutputProjection | null>`.
- Extends: `SyncJobRepository.recordProgress({ outputs?: readonly StageOutputDraft[] })` so output upsert and terminal stage update share one fenced transaction.

- [ ] **Step 1: Write failing projector and persistence tests**

```js
test("projectStageOutput hashes only the fixed sales projection", () => {
  const draft = projectStageOutput("sales_trend", ["B0TEST0001"], {
    readExport: (_file, name) => name === "sorftimeSalesTrendData"
      ? { B0TEST0001: { status: "ready", volume: [] }, B0OTHER001: { status: "ready" } }
      : {},
    now: () => "2026-08-25T09:00:00.000Z",
  });
  assert.deepEqual(Object.keys(draft.data.trendByAsin), ["B0TEST0001"]);
  assert.match(draft.contentHash, /^[a-f0-9]{64}$/);
});
```

```ts
test("terminal stage and output commit atomically and repeated mirror polls do not raise versions", async () => {
  const first = await store.recordProgress(progressWithOutput("done", salesDraft));
  const output = await store.readStageOutput(exactScope("sales_trend"));
  assert.equal(first.stages.find(stage => stage.id === "sales_trend")?.status, "done");
  assert.equal(output?.jobVersion, first.jobVersion);
  assert.equal(output?.outputVersion, 1);
  await store.recordProgress(progressWithOutput("done", salesDraft));
  assert.equal((await store.readStageOutput(exactScope("sales_trend")))?.outputVersion, 1);
});
```

- [ ] **Step 2: Run the RED tests**

Run: `node --test tests/scripts/sync-stage-output.test.mjs && npx tsx --conditions=react-server --test tests/agent/sync-stage-output-persistence.test.ts`

Expected: FAIL because the projector, output draft, repository method, mirror parser, and versioned upsert are missing.

- [ ] **Step 3: Implement the projector and atomic repository write**

Use these exact interfaces:

```ts
export interface StageOutputDraft {
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stage: ProjectableSyncStage;
  readonly stageStatus: "done" | "partial" | "failed";
  readonly contentHash: string;
  readonly updatedAt: string;
  readonly data?: Record<string, unknown>;
  readonly gap?: { state: "partial" | "failed"; reasonCode: "CONNECT_TIMEOUT" | "UPSTREAM_EMPTY" | "CONNECTOR_FAILED" };
}

readStageOutput(input: {
  organizationId: string; projectId: string; runId: string; jobId: string; stage: ProjectableSyncStage;
}): Promise<StageOutputProjection | null>;
```

`projectStageOutput` must select only requested ASINs, canonicalize object keys before hashing, and emit a fixed gap for every `partial`/`failed` stage. In `recordProgress`, upsert the output first; raise `output_version` and `sync_jobs.job_version` only when `stage_status`, `content_hash`, `data_json`, or `gap_json` changed; then write the terminal stage status in the same transaction. Repeated mirror polls with identical content are no-ops for both versions.

Replace each of the seven exposed runner terminal writes with one atomic mirror mutation:

```js
commitProjectableStage(jobId, {
  stageId,
  stagePatch: { status, detail, completedAt },
  output: projectStageOutput(stageId, asins, {
    stageStatus: status,
    gapReasonCode,
    updatedAt: completedAt,
  }),
});
```

Do not project `catalog`, `child_sales`, `price_strategy`, `image_remarks`, `alexa_voc`, or `build`. Ignore output drafts in the worker when project/run IDs are absent or do not exactly match the leased job.

- [ ] **Step 4: Run the GREEN tests**

Run: `node --test tests/scripts/sync-stage-output.test.mjs && npx tsx --conditions=react-server --test tests/agent/sync-stage-output-persistence.test.ts`

Expected: PASS; terminal visibility is inseparable from persistence, hashes are deterministic, and duplicate polls do not change versions.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/sync-stage-output.mjs scripts/lib/sync-job-store.mjs scripts/run-asin-sync-job.mjs server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-worker-handler.ts tests/scripts/sync-stage-output.test.mjs tests/agent/sync-stage-output-persistence.test.ts
git commit -m "feat: persist terminal stage projections"
```

### Task 3: Add the scope-checked read-only stage-output API

**Files:**
- Create: `tests/agent/stage-output-route.test.ts`
- Modify: `server/services/sync-job-service.ts`
- Modify: `server/routes/local-data.ts`
- Modify: `server/auth/authorization.ts`
- Modify: `app/lib/agent-service-client.ts`
- Modify: `tests/agent/auth-authorization.test.ts`

**Interfaces:**
- Consumes: `SyncJobRepository.readStageOutput(input)` from Task 2.
- Produces: `SyncJobService.readStageOutput(input): Promise<StageOutputProjection | null>`.

- [ ] **Step 1: Write failing authorization/read-only tests**

```ts
for (const mutation of ["organization", "project", "run", "job", "stage"] as const) {
  test(`stage output hides ${mutation} mismatch`, async () => {
    const response = await app.inject({
      method: "GET",
      url: routeWithMismatch(mutation),
      headers: authenticatedHeaders,
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: { code: "NOT_FOUND", message: "Stage output not found" } });
  });
}

test("stage output GET is side-effect free", async () => {
  const response = await app.inject({ method: "GET", url: exactRoute, headers: authenticatedHeaders });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(counters, { providers: 0, builds: 0, reloads: 0, jobs: 0, runs: 0, stages: 0, attempts: 0 });
});
```

- [ ] **Step 2: Run the RED test**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-route.test.ts tests/agent/auth-authorization.test.ts`

Expected: FAIL with a missing route/service and no route classification assertion.

- [ ] **Step 3: Implement one exact scoped lookup**

```ts
async readStageOutput(input: {
  organizationId: string; projectId: string; runId: string; jobId: string; stage: ProjectableSyncStage;
}) {
  return await this.#syncJobs.readStageOutput(input);
}
```

Register the GET route, require a user principal, pass `principal.organizationId`, parse all params with the shared schema, and return the same `404` for a legacy job, non-terminal stage, or any persisted scope mismatch; unauthenticated callers remain rejected by the existing session middleware. The PostgreSQL query must join `sync_job_stage_outputs`, `sync_jobs`, `projects`, and `analysis_runs` and compare all persisted IDs; do not load by job ID and authorize afterward. `classifyRoute` keeps the endpoint under the default member/admin session rule.

- [ ] **Step 4: Run the GREEN test**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-route.test.ts tests/agent/auth-authorization.test.ts`

Expected: PASS; exact scope returns normalized JSON while every mismatch is indistinguishable and counters remain zero.

- [ ] **Step 5: Commit**

```bash
git add server/services/sync-job-service.ts server/routes/local-data.ts server/auth/authorization.ts app/lib/agent-service-client.ts tests/agent/stage-output-route.test.ts tests/agent/auth-authorization.test.ts
git commit -m "feat: expose scoped stage output reads"
```

### Task 4: Fetch each terminal module once and render a scoped browser overlay

**Files:**
- Create: `app/lib/stage-output-browser.ts`
- Create: `tests/agent/stage-output-browser.test.ts`
- Modify: `app/asin-sync-funnel.tsx`
- Modify: `app/page.tsx`
- Modify: `app/keyword-fetch-status.tsx`
- Modify: `app/keyword-demand-analysis.ts`
- Modify: `app/category-node-trend-section.tsx`
- Modify: `app/listing-images-section.tsx`
- Modify: `app/listing-aplus-section.tsx`
- Modify: `tests/agent/asin-sync-session.test.ts`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx`

**Interfaces:**
- Consumes: `StageOutputProjection` and `SyncJob.jobVersion`.
- Produces: `createStageOutputOwner(scope)` with `observeJob`, `accept`, `snapshot`, and `clear`.
- Produces: `SyncResumeBundle.onStageOutput?: (snapshot: StageOutputSnapshot) => void`.

- [ ] **Step 1: Write failing cache, stale-response, and browser tests**

```ts
test("owner fetches only terminal transitions or higher job versions", () => {
  const owner = createStageOutputOwner(scope);
  assert.deepEqual(owner.observeJob(job(7, { keywords: "done" })), ["keywords"]);
  owner.accept(projection("keywords", 7, 1, keywordHash));
  assert.deepEqual(owner.observeJob(job(7, { keywords: "done" })), []);
  assert.deepEqual(owner.observeJob(job(8, { keywords: "done" })), ["keywords"]);
});

test("owner rejects foreign, stale, and hash-invalid responses", () => {
  const owner = createStageOutputOwner(scope);
  assert.equal(owner.accept(projection("keywords", 6, 1, keywordHash)), true);
  assert.equal(owner.accept({ ...projection("keywords", 5, 2, keywordHash), jobId: "foreign-job" }), false);
  assert.equal(owner.snapshot().keywords?.jobVersion, 6);
});
```

The `asin-sync-session.test.ts` case must drive the existing 1.5-second job endpoint through `asin-sync-funnel-browser-harness.tsx` and terminal stages in this order: `keywords`, `reviews`, `sales_trend`, `fba`, `listing`, `category`, `traffic`. In the existing Node/DOM harness it asserts one stage-output GET per accepted version, visible module markers before build/publication, no duplicate update for an identical response, and `performance.getEntriesByType("navigation").length === 1` throughout.

- [ ] **Step 2: Run the RED tests**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-browser.test.ts tests/agent/asin-sync-session.test.ts`

Expected: FAIL because no owner observes stages and the funnel never calls the stage-output endpoint.

- [ ] **Step 3: Implement the owner and reuse the existing poll**

```ts
export type StageOutputScope = Readonly<{
  organizationId: string; projectId: string; runId: string; jobId: string;
}>;

export type StageOutputSnapshot = Readonly<Partial<Record<ProjectableSyncStage, StageOutputProjection>>>;

export function createStageOutputOwner(scope: StageOutputScope): {
  observeJob(job: Pick<SyncJob, "jobId" | "jobVersion" | "stages">): ProjectableSyncStage[];
  accept(projection: StageOutputProjection): boolean;
  snapshot(): StageOutputSnapshot;
  clear(): void;
};
```

Inside the existing `poll` function, call `owner.observeJob(payload)` after scope validation, issue stage GETs without another timer, validate each response with `LocalDataStageOutputResponseSchema`, and call `accept`. A failed stage GET leaves the current snapshot untouched and is reconsidered on the next job poll. The owner key includes session organization, path scope, job, stage, and hash; acceptance compares all four response IDs plus stage, refuses lower `(jobVersion, outputVersion)`, and recomputes the canonical JSON hash before storing.

In `app/page.tsx`, merge each accepted `data` branch over the imported static fallback and render fixed gap cards for `partial`/`failed`. Pass overlay maps into the listed child components. Successful overlays remain mounted when a later projection is a gap or publication is pending/failed. Reset the owner and overlay on logout, pathname/search scope change, or sync job replacement.

- [ ] **Step 4: Run the GREEN tests**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-browser.test.ts tests/agent/asin-sync-session.test.ts`

Expected: PASS; seven modules appear incrementally, stale/foreign responses are ignored, identical versions do not rerender, poll failures preserve content, and navigation count stays one before publication.

- [ ] **Step 5: Commit**

```bash
git add app/lib/stage-output-browser.ts app/asin-sync-funnel.tsx app/page.tsx app/keyword-fetch-status.tsx app/keyword-demand-analysis.ts app/category-node-trend-section.tsx app/listing-images-section.tsx app/listing-aplus-section.tsx tests/agent/stage-output-browser.test.ts tests/agent/asin-sync-session.test.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx
git commit -m "feat: render incremental stage outputs"
```

### Task 5: Reconcile the final artifact with persisted stage hashes

**Files:**
- Create: `tests/agent/sync-publication-reconciliation.test.ts`
- Modify: `scripts/lib/web-artifact-store.mjs`
- Modify: `scripts/lib/web-reload-request.mjs`
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify: `scripts/start-agent-stack.mjs`
- Modify: `server/services/sync-publication-status-service.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `tests/scripts/web-artifact-store.test.mjs`
- Modify: `tests/scripts/web-reload-request.test.mjs`
- Modify: `tests/scripts/start-agent-stack.test.mjs`

**Interfaces:**
- Consumes: final `jobVersion` and per-stage `contentHash` values from Task 2.
- Produces artifact manifest version 2: `{ version: 2, artifactId, jobId, jobVersion, stageContentHashes }` and reload request version 3 carrying the same reconciliation fields.
- Produces publication failure code: `WEB_PUBLICATION_CONTENT_MISMATCH` in addition to the existing `WEB_PUBLICATION_FAILED`.

- [ ] **Step 1: Write failing reconciliation tests**

```ts
test("publication refuses a missing or mismatched displayed module", async () => {
  const result = await service.read(jobId, {
    jobVersion: 9,
    stageContentHashes: { keywords: keywordHash, category: categoryHash },
  });
  assert.deepEqual(result, {
    status: "failed",
    requestId,
    artifactId,
    requestedAt,
    failedAt,
    code: "WEB_PUBLICATION_CONTENT_MISMATCH",
  });
});
```

- [ ] **Step 2: Run the RED tests**

Run: `node --test tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs && npx tsx --conditions=react-server --test tests/agent/sync-publication-reconciliation.test.ts`

Expected: FAIL because artifact/reload/publication records carry only `artifactId`.

- [ ] **Step 3: Bind build, reload acknowledgement, and publication status**

Before the single final production build, load the final persisted projection set and recompute each source projection with `projectStageOutput`; abort publication with fixed mismatch status if a ready module is missing or a hash differs. After the build, write manifest version 2, bump `WEB_RELOAD_REQUEST_VERSION` from 2 to 3, and include the same immutable fields in the reload request and supervisor acknowledgement:

```ts
type WebArtifactManifestV2 = Readonly<{
  version: 2;
  artifactId: string;
  jobId: string;
  jobVersion: number;
  stageContentHashes: Readonly<Partial<Record<ProjectableSyncStage, string>>>;
}>;
```

The supervisor validates the candidate manifest before replacement. `SyncPublicationStatusService` reports `applied` only when acknowledgement artifact/job/version/hashes equal the current persisted job view; otherwise it reports `WEB_PUBLICATION_CONTENT_MISMATCH`. Keep stage projections available on mismatch and never replace the Web child with an old or incomplete artifact.

- [ ] **Step 4: Run the GREEN tests**

Run: `node --test tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs && npx tsx --conditions=react-server --test tests/agent/sync-publication-reconciliation.test.ts`

Expected: PASS; matching artifacts apply, missing/hash-stale artifacts fail closed, and the known-good Web child remains active.

- [ ] **Step 5: Commit**

```bash
git add shared/agent-contracts.ts scripts/lib/web-artifact-store.mjs scripts/lib/web-reload-request.mjs scripts/run-asin-sync-job.mjs scripts/start-agent-stack.mjs server/services/sync-publication-status-service.ts tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs tests/agent/sync-publication-reconciliation.test.ts
git commit -m "feat: reconcile publication stage hashes"
```

## Task Group B: Sorftime category single CONNECT_TIMEOUT retry

### Task 6: Record and execute one governed transient category retry

**Files:**
- Create: `server/db/migrations/postgres/0017_category_transient_retry.sql`
- Create: `tests/scripts/sorftime-category-retry.test.mjs`
- Modify: `scripts/lib/postgres-resource-governor.mjs`
- Modify: `scripts/lib/sorftime-mcp-client.mjs`
- Modify: `server/services/sync-job-worker-handler.ts`
- Modify: `tests/agent/postgres-migrations.test.ts`
- Modify: `tests/agent/postgres-concurrency-control.test.ts`

**Interfaces:**
- Extends governor input with `stageId: string`, `logicalOperationKey: string`, and physical `dispatchKey: string`.
- Adds `attemptKind: "transient-retry"` while retaining `initial`, `retry`, `repair`, `probe`, and `quota-refresh`.
- Produces `requestSorftimeMcp` behavior: only category + first `CONNECT_TIMEOUT` causes one second governed dispatch.

- [ ] **Step 1: Write failing physical-attempt tests**

```js
test("category CONNECT_TIMEOUT retries once through the governor", async () => {
  const attempts = [];
  const result = await requestSorftimeMcp("key", "tools/call", categoryParams, {
    env: categoryEnv,
    resourceGovernor: recordingGovernor(attempts),
    fetchImpl: timeoutThenSuccessFetch(),
  });
  assert.equal(result.jsonrpc, "2.0");
  assert.deepEqual(attempts.map(item => item.attemptKind), ["initial", "transient-retry"]);
  assert.equal(attempts.every(item => item.stageId === "category"), true);
  assert.equal(new Set(attempts.map(item => item.logicalOperationKey)).size, 1);
  const base = attempts[0].logicalOperationKey;
  assert.deepEqual(attempts.map(item => item.dispatchKey), [
    `${base}:initial`,
    `${base}:transient-retry`,
  ]);
  assert.equal(new Set(attempts.map(item => item.dispatchKey)).size, 2);
});

test("non-category and non-CONNECT_TIMEOUT failures dispatch once", async () => {
  assert.equal(await dispatchCount({ stage: "reviews", code: "UND_ERR_CONNECT_TIMEOUT" }), 1);
  assert.equal(await dispatchCount({ stage: "category", code: "ECONNRESET" }), 1);
});
```

- [ ] **Step 2: Run the RED tests**

Run: `node --test tests/scripts/sorftime-category-retry.test.mjs && npx tsx --conditions=react-server --test tests/agent/postgres-concurrency-control.test.ts tests/agent/postgres-migrations.test.ts`

Expected: FAIL because `transient-retry`, stage/dispatch metadata, and retry logic do not exist.

- [ ] **Step 3: Add migration 0017 and the two-dispatch loop**

Migration 0017 replaces the permit/attempt `attempt_kind` checks to include `transient-retry`, adds non-null bounded `stage_id`, `logical_operation_key`, and `dispatch_key` columns with safe backfills for existing rows, and indexes `(organization_id, job_id, stage_id, logical_operation_key, recorded_at)`. Update the fresh migration count to 17.

Use this bounded decision in `requestSorftimeMcp`; the first error is classified without opening the process breaker, and only the second error reaches `runWithProviderDiagnostics`:

```js
const firstKind = options.attemptKind ?? options.env?.AGENT_RESOURCE_ATTEMPT_KIND ?? "initial";
try {
  return await dispatchPhysical(firstKind);
} catch (error) {
  const diagnostic = classifyProviderFailure(error, diagnosticInput);
  const eligible = diagnosticInput.stage === "category"
    && diagnostic.causeCode === "CONNECT_TIMEOUT"
    && firstKind !== "transient-retry";
  if (!eligible) throw error;
  return await dispatchPhysical("transient-retry");
}
```

`requestSorftimeMcp` must derive one deterministic `logicalOperationKey` from method, tool name, ASIN/node, and trend index. `dispatchPhysical(attemptKind)` must call `governExternalRequest` separately each time with that shared logical key and the unique physical key `${logicalOperationKey}:${attemptKind}`. The first and second category attempt therefore persist the same logical operation key while their physical keys end in `:initial` and `:transient-retry`, respectively. Pass `stageId` from `AGENT_SYNC_STAGE_ID`. In the worker child environment, use `repair` for an explicit resumed lease and `initial` otherwise.

- [ ] **Step 4: Run the GREEN tests**

Run: `node --test tests/scripts/sorftime-category-retry.test.mjs && npx tsx --conditions=react-server --test tests/agent/postgres-concurrency-control.test.ts tests/agent/postgres-migrations.test.ts`

Expected: PASS; first and second calls each acquire/release a permit and write one correctly classified physical-attempt row, while ineligible failures have one row.

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/postgres/0017_category_transient_retry.sql scripts/lib/postgres-resource-governor.mjs scripts/lib/sorftime-mcp-client.mjs server/services/sync-job-worker-handler.ts tests/scripts/sorftime-category-retry.test.mjs tests/agent/postgres-concurrency-control.test.ts tests/agent/postgres-migrations.test.ts
git commit -m "feat: bound category connect timeout retry"
```

### Task 7: Fail category closed and resume only the original category work

**Files:**
- Create: `tests/agent/sync-category-resume.test.ts`
- Modify: `scripts/build-sorftime-category-trend.mjs`
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/services/sync-job-service.ts`
- Modify: `server/routes/local-data.ts`
- Modify: `tests/agent/sync-job-production-main-resume.test.ts`
- Modify: `tests/agent/postgres-sync-job-repository.test.ts`
- Modify: `tests/agent/asin-sync-session.test.ts`

**Interfaces:**
- Consumes: governed retry and attempt metadata from Task 6.
- Produces fixed category gap `{ state: "failed", reasonCode: "CONNECT_TIMEOUT" }`.
- Produces repository resume selection exactly `resumedStages: ["category"]` for the permanent category gap.

- [ ] **Step 1: Write failing permanent-timeout and resume tests**

```ts
test("permanent category timeout has two attempts, no third dispatch, and preserves other modules", async () => {
  const result = await runCategoryFixture({ outcomes: ["CONNECT_TIMEOUT", "CONNECT_TIMEOUT"] });
  assert.deepEqual(result.attempts.map(item => item.attemptKind), ["initial", "transient-retry"]);
  assert.equal(result.providerDispatches, 2);
  assert.deepEqual(result.categoryOutput.gap, { state: "failed", reasonCode: "CONNECT_TIMEOUT" });
  assert.equal(result.outputs.keywords.data.analysisByAsin.B0TEST0001.status, "ready");
});

test("explicit resume reuses the original category identifiers", async () => {
  const before = await identityCounts(pool, jobId);
  const resumed = await service.resume({ jobId, organizationId, actorId });
  const after = await identityCounts(pool, jobId);
  assert.deepEqual(resumed?.resumedStages, ["category"]);
  assert.deepEqual(after, before);
  assert.equal(resumed?.job.jobId, jobId);
});
```

- [ ] **Step 2: Run the RED tests**

Run: `npx tsx --conditions=react-server --test tests/agent/sync-category-resume.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/postgres-sync-job-repository.test.ts tests/agent/asin-sync-session.test.ts`

Expected: FAIL because category execution continues/falls back after the timeout and generic resume is not restricted to the permanent category gap.

- [ ] **Step 3: Implement fail-closed category flow and exact resume guards**

Make category discovery and trend requests sequential. In every category catch, immediately rethrow a final `ProviderDiagnosticError` whose diagnostic is `category/CONNECT_TIMEOUT`; do not fall back to name lookup, continue to another node, or launch another `category_trend`. The runner maps that diagnostic to the fixed projection gap, marks category terminal partial/failed, and continues non-category post-processing without clearing previous outputs.

Change resume eligibility to require all of the following in one serializable transaction: exact organization/project/run/job scope, terminal category projection with `CONNECT_TIMEOUT`, no live lease/Worker, and no other selected stage. Preserve the output row and all `concurrency_physical_attempts`; reset only category stage/module states and set `error.resumeStages` to `['category']`.

```ts
const categoryOnlyResume = Object.freeze({
  resumedStages: ["category"] as const,
  createSyncJobs: 0,
  createAnalysisRuns: 0,
  createRunStages: 0,
  createOtherWorkItems: 0,
});
```

The resumed child uses `repair` for its first physical request and is again eligible for exactly one `transient-retry`. The route remains the existing admin POST and performs no probe.

- [ ] **Step 4: Run the GREEN tests**

Run: `npx tsx --conditions=react-server --test tests/agent/sync-category-resume.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/postgres-sync-job-repository.test.ts tests/agent/asin-sync-session.test.ts`

Expected: PASS; permanent timeout has no third dispatch, fixed gap remains visible, and explicit resume adds zero IDs while retaining and extending the attempt trail.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-sorftime-category-trend.mjs scripts/run-asin-sync-job.mjs server/db/postgres/sync-job-store.ts server/services/sync-job-service.ts server/routes/local-data.ts tests/agent/sync-category-resume.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/postgres-sync-job-repository.test.ts tests/agent/asin-sync-session.test.ts
git commit -m "feat: fail closed and resume category in place"
```

## Combined Acceptance Gate

### Task 8: Prove both slices in one acceptance batch

**Files:**
- Create: `tests/agent/stage-results-category-retry-acceptance.test.ts`
- Create: `tests/agent/helpers/stage-results-category-retry-fixture.ts`
- Create: `tsconfig.stage-results-category-retry.json`

**Interfaces:**
- Consumes every public interface from Tasks 1-7.
- Produces one release decision for both independently reversible slices.

- [ ] **Step 1: Write the failing combined acceptance fixture**

```ts
test("stage visibility and category retry pass one acceptance batch", async () => {
  const transient = await fixture.run({ category: ["CONNECT_TIMEOUT", "success"] });
  assert.deepEqual(transient.categoryAttemptKinds, ["initial", "transient-retry"]);
  assert.equal(transient.categoryReady, true);
  assert.equal(transient.followingStageRan, true);

  const permanent = await fixture.run({ category: ["CONNECT_TIMEOUT", "CONNECT_TIMEOUT"] });
  assert.equal(permanent.categoryDispatches, 2);
  assert.equal(permanent.thirdDispatches, 0);
  assert.deepEqual(permanent.categoryGap, { state: "failed", reasonCode: "CONNECT_TIMEOUT" });
  assert.equal(permanent.successfulModulesRemainVisible, true);

  assert.deepEqual(permanent.visibleBeforePublication, [
    "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  ]);
  assert.equal(permanent.globalReloadsBeforeAppliedPublication, 0);
  assert.equal(permanent.stageOutputReadSideEffects, 0);
  assert.equal(permanent.artifactHashesMatch, true);
  assert.equal(permanent.fixtureBuilds, 0);

  const resumed = await fixture.resumeCategory(permanent.jobId);
  assert.deepEqual(resumed.newIds, { jobs: 0, runs: 0, runStages: 0 });
  assert.deepEqual(resumed.selectedStages, ["category"]);
  assert.equal(resumed.providerProbes, 0);
});
```

- [ ] **Step 2: Run the full acceptance command and inspect RED if any contract is still disconnected**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-results-category-retry-acceptance.test.ts tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/agent/stage-output-route.test.ts tests/agent/stage-output-browser.test.ts tests/agent/sync-publication-reconciliation.test.ts tests/agent/sync-category-resume.test.ts && node --test tests/scripts/sync-stage-output.test.mjs tests/scripts/sorftime-category-retry.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs`

Expected before the fixture is fully wired: FAIL at the first missing cross-slice observation, with no live provider, Web service, or browser required.

- [ ] **Step 3: Complete only the deterministic acceptance fixture wiring**

```ts
export type AcceptanceResult = Readonly<{
  jobId: string;
  categoryAttemptKinds: readonly string[];
  categoryDispatches: number;
  thirdDispatches: number;
  categoryReady: boolean;
  categoryGap: Readonly<{ state: "failed"; reasonCode: "CONNECT_TIMEOUT" }> | null;
  followingStageRan: boolean;
  visibleBeforePublication: readonly ProjectableSyncStage[];
  successfulModulesRemainVisible: boolean;
  globalReloadsBeforeAppliedPublication: number;
  stageOutputReadSideEffects: number;
  artifactHashesMatch: boolean;
  fixtureBuilds: number;
}>;
```

Create the helper at `tests/agent/helpers/stage-results-category-retry-fixture.ts` and use in-memory fake transport/browser counters plus the existing PostgreSQL test container helper. The fixture must report `fixtureBuilds: 0`; do not call a real provider, start the stack, trigger a build, publish, reload, or open a real browser.

Create the affected-file typecheck at `tsconfig.stage-results-category-retry.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "incremental": false },
  "files": [
    "shared/agent-contracts.ts",
    "app/lib/sync-server.ts",
    "app/lib/agent-service-client.ts",
    "app/lib/stage-output-browser.ts",
    "app/asin-sync-funnel.tsx",
    "app/page.tsx",
    "app/keyword-fetch-status.tsx",
    "app/keyword-demand-analysis.ts",
    "app/category-node-trend-section.tsx",
    "app/listing-images-section.tsx",
    "app/listing-aplus-section.tsx",
    "server/db/sync-job-repository.ts",
    "server/db/postgres/sync-job-store.ts",
    "server/services/sync-job-worker-handler.ts",
    "server/services/sync-job-service.ts",
    "server/services/sync-publication-status-service.ts",
    "server/routes/local-data.ts",
    "server/auth/authorization.ts",
    "tests/agent/stage-output-contract.test.ts",
    "tests/agent/postgres-migrations.test.ts",
    "tests/agent/agent-api-schema.test.ts",
    "tests/agent/sync-stage-output-persistence.test.ts",
    "tests/agent/stage-output-route.test.ts",
    "tests/agent/auth-authorization.test.ts",
    "tests/agent/stage-output-browser.test.ts",
    "tests/agent/asin-sync-session.test.ts",
    "tests/agent/helpers/asin-sync-funnel-browser-harness.tsx",
    "tests/agent/sync-publication-reconciliation.test.ts",
    "tests/agent/postgres-concurrency-control.test.ts",
    "tests/agent/sync-category-resume.test.ts",
    "tests/agent/sync-job-production-main-resume.test.ts",
    "tests/agent/postgres-sync-job-repository.test.ts",
    "tests/agent/stage-results-category-retry-acceptance.test.ts",
    "tests/agent/helpers/stage-results-category-retry-fixture.ts"
  ],
  "include": []
}
```

- [ ] **Step 4: Run the combined acceptance batch**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-results-category-retry-acceptance.test.ts tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/agent/stage-output-route.test.ts tests/agent/stage-output-browser.test.ts tests/agent/sync-publication-reconciliation.test.ts tests/agent/sync-category-resume.test.ts && node --test tests/scripts/sync-stage-output.test.mjs tests/scripts/sorftime-category-retry.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs`

Expected: PASS with seven pre-publication module observations, zero pre-publication reloads, exact scoped read rejection, one transient retry, two-attempt permanent closure, category-only original-job resume, and matching final artifact hashes.

- [ ] **Step 5: Run exact changed-file lint and the affected TypeScript gate**

Run:

```powershell
npx eslint shared/agent-contracts.ts app/lib/sync-server.ts app/lib/agent-service-client.ts app/lib/stage-output-browser.ts app/asin-sync-funnel.tsx app/page.tsx app/keyword-fetch-status.tsx app/keyword-demand-analysis.ts app/category-node-trend-section.tsx app/listing-images-section.tsx app/listing-aplus-section.tsx server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-worker-handler.ts server/services/sync-job-service.ts server/services/sync-publication-status-service.ts server/routes/local-data.ts server/auth/authorization.ts scripts/lib/sync-stage-output.mjs scripts/lib/sync-job-store.mjs scripts/run-asin-sync-job.mjs scripts/lib/web-artifact-store.mjs scripts/lib/web-reload-request.mjs scripts/start-agent-stack.mjs scripts/lib/postgres-resource-governor.mjs scripts/lib/sorftime-mcp-client.mjs scripts/build-sorftime-category-trend.mjs tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/agent/stage-output-route.test.ts tests/agent/stage-output-browser.test.ts tests/agent/sync-publication-reconciliation.test.ts tests/agent/sync-category-resume.test.ts tests/agent/stage-results-category-retry-acceptance.test.ts tests/agent/helpers/stage-results-category-retry-fixture.ts tests/agent/asin-sync-session.test.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/auth-authorization.test.ts tests/agent/postgres-migrations.test.ts tests/agent/agent-api-schema.test.ts tests/agent/postgres-concurrency-control.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/postgres-sync-job-repository.test.ts tests/scripts/sync-stage-output.test.mjs tests/scripts/sorftime-category-retry.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs
npx tsc --noEmit -p tsconfig.stage-results-category-retry.json
```

Expected: both commands exit 0; lint touches exactly the changed source/tests and the focused TypeScript project checks only affected TypeScript entry points plus their imports. The affected Node/DOM and script tests already passed in Step 4.

- [ ] **Step 6: Run the one final production build after all focused and combined tests pass**

Run: `npm run build`

Expected: exit 0 with one production artifact build. This is the only build command in the plan; the deterministic fixture itself records zero builds.

- [ ] **Step 7: Verify the implementation diff remains within scope**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the files named in Tasks 1-8 are modified or untracked, with no deployment, report, provider-output, or generated build artifacts.

- [ ] **Step 8: Commit the combined acceptance fixture and focused type config**

```bash
git add tests/agent/stage-results-category-retry-acceptance.test.ts tests/agent/helpers/stage-results-category-retry-fixture.ts tsconfig.stage-results-category-retry.json
git commit -m "test: gate stage outputs and category retry"
```

## Plan Self-Review

- Spec coverage: Tasks 1-4 cover exact auth scope, persistence-before-terminal, version/hash cache, fixed gaps, seven module mappings, one 1.5-second poll, stale response rejection, retention, and zero early reload. Task 5 covers final build/publication reconciliation. Tasks 6-7 cover governed physical accounting, one category-only timeout retry, no third dispatch, fixed timeout gap, and original-job category-only resume. Task 8 proves both slices in one batch.
- Scope: no task adds event transport, provider probe, per-stage build/reload, new connector behavior, new job/run/stage IDs on resume, dependency, deployment, or live operation.
- Type consistency: `ProjectableSyncStage`, `StageOutputDraft`, `StageOutputProjection`, `jobVersion`, `outputVersion`, `contentHash`, `logicalOperationKey`, unique physical `dispatchKey`, `transient-retry`, and `WEB_PUBLICATION_CONTENT_MISMATCH` retain the same names and meanings across producers and consumers.
- Marker scan: the plan contains no unresolved marker, deferred implementation instruction, or vague test-only step; each task has explicit RED, RED verification, GREEN implementation, GREEN verification, and commit actions.
- Verdict: complete and internally consistent with the confirmed design; no spec gap or execution blocker remains.
