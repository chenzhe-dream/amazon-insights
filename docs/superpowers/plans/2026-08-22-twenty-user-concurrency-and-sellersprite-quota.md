# Twenty-User Concurrency And SellerSprite Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Accept twenty simultaneous authenticated 3-ASIN submissions, persist and fairly schedule them through PostgreSQL, bound every external request, and expose safe SellerSprite quota/queue controls to administrators.

**Architecture:** PostgreSQL becomes the only authority for sync-job identity, admission, queue position, leases, resource permits, quota snapshots, and policy versions. The existing detached `.mjs` collectors remain execution adapters; `data/sync-jobs/*.json` becomes a redacted diagnostic mirror only. A lease-based dispatcher runs bounded whole jobs, while a PostgreSQL governor coordinates parent and child processes.

**Tech Stack:** Node.js 24, TypeScript, PostgreSQL 16/`pg`, Fastify, Zod, React/vinext, Node test runner through `tsx`, Playwright, Docker-backed PostgreSQL tests.

## Fixed Decisions And Guardrails

- Default `standard` profile: whole jobs `4`, SellerSprite `2`, SIF `1`, Sorftime `1`, model `2`, image `2`.
- Per user: one running and two queued jobs. Per organization: at most one hundred non-terminal jobs.
- Active dedupe key: organization + marketplace + sorted unique ASINs + freshness window. Project/run IDs remain audit links, not identity.
- SellerSprite hard ceiling: `30` physical requests per rolling 60 seconds, counting retries, probes, and quota checks.
- SellerSprite remaining below 20% warns; below 10% downgrades to conservative; zero or `ERROR_VISIT_MAX` pauses only SellerSprite-dependent work.
- Unknown purchased total stays `总额度未知`; never invent a percentage. Only primary administrator `admin@example.com` can change the total or policy.
- Ordinary administrators have read-only concurrency/quota access. Members see only their own safe job projection.
- PostgreSQL is required for this feature. SQLite and JSON files must not decide admission, dedupe, ownership, leases, or limits.
- PostgreSQL pool maximum is `10` per Agent Service process; child collectors use a single short-lived connection.
- Fake providers prove 20-user capacity. Real providers are verified only at 1, 2, then 4 whole jobs and stop on quota/rate/error evidence.
- Preserve current WIP, migrations `0001`–`0010`, generated data, credentials, package lock, and AgentRun lease behavior. Never reset, clean, stash, rebase, amend, or push.
- For every task: confirm an empty index, stage only listed paths, inspect `git diff --cached`, then create a normal commit.

## Existing Boundaries To Reuse

- `server/db/postgres/job-store.ts` already proves atomic claim, lease, heartbeat, expiry recovery, and fencing for AgentRun jobs.
- `app/lib/sync-server.ts` and `scripts/lib/sync-job-store.mjs` currently own file-backed sync admission and launch `scripts/run-asin-sync-job.mjs`; this is the authority that must move to PostgreSQL.
- `server/connectors/remote-mcp-connector.ts` has only process-local limiting. Direct `.mjs` collectors bypass it, so the new governor must wrap the physical request boundary in both runtimes.
- `app/lib/asin-sync-session.ts` already restores `syncJob` from the URL and polls with GET after refresh. Keep that behavior.
- `app/lib/primary-admin.ts` is presentation-only. Mutation authorization must load the session user server-side and verify role plus normalized email.

---

### Task 1: Add The PostgreSQL Queue And Public Contract

**Files**

- Create: `server/db/migrations/postgres/0011_sync_job_queue.sql`
- Create: `server/db/sync-job-repository.ts`
- Create: `server/db/postgres/sync-job-store.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/postgres-repository.ts`
- Modify: `server/db/open-runtime-repository.ts`
- Modify: `shared/agent-api.ts`
- Test: `tests/agent/postgres-sync-job-repository.test.ts`
- Test: `tests/agent/agent-api-schema.test.ts`

**Stable interfaces**

- `SyncJobRepository.admit(input): Promise<{ job; disposition: "created" | "deduplicated" }>`
- `claimNext({ workerId, leaseMs, wholeJobLimit }): Promise<SyncJobLease | null>`
- `heartbeat`, `recordProgress`, `complete`, and `fail` require `jobId + leaseGeneration` fencing.
- Add strict `LocalDataSyncJobPublicSchema`; routes must project through it so lease owner, command, log path, credentials, and upstream payloads cannot cross HTTP.

**TDD steps**

- [ ] RED: write migration/repository tests for restart persistence, tenant scope, stage/module persistence, and public-schema rejection of internal lease fields.
- [ ] GREEN: add `sync_jobs`, `sync_job_submissions`, and `sync_job_modules`; use explicit status checks, timestamps, indexes, and a partial unique active fingerprint.
- [ ] GREEN: compose the store into `RuntimeAgentRepository`; expose a PostgreSQL capability check and fail closed only for sync-queue operations when storage is not PostgreSQL.
- [ ] Set the production pool `max: 10` without changing existing AgentRun semantics.
- [ ] Run: `npx tsx --conditions=react-server --test tests/agent/postgres-sync-job-repository.test.ts tests/agent/agent-api-schema.test.ts`
- [ ] Run: `npm run lint -- --quiet`
- [ ] Commit only these paths: `feat(concurrency): add postgres sync queue foundation`

---

### Task 2: Make Admission, Deduplication, And Fair Claim Atomic

**Files**

- Modify: `server/db/postgres/sync-job-store.ts`
- Create: `server/services/sync-job-service.ts`
- Modify: `server/routes/local-data.ts`
- Modify: `server/app.ts`
- Test: `tests/agent/postgres-sync-job-repository.test.ts`
- Test: `tests/agent/local-data-bridge.test.ts`

**Behavior**

- Admission transaction normalizes marketplace/ASINs, reuses an active fingerprint, rejects a third queued job for one user, and rejects organization backlog above 100.
- Fair claim selects the oldest first queued job for a user with no running job; `FOR UPDATE SKIP LOCKED` prevents double claim across processes.
- Until versioned policy lands in Task 4, `wholeJobLimit` is injected and defaults to the fixed standard limit `4`.

**TDD steps**

- [ ] RED: race 20 concurrent identical requests and assert one job plus 20 submissions; race distinct jobs and assert per-user/org limits.
- [ ] RED: queue a noisy user before several quiet users and assert round-robin-by-user claim order, one running job per user, and no duplicate lease.
- [ ] GREEN: implement serializable admission/retry and fair claim SQL; preserve `202` start and authenticated GET polling contracts.
- [ ] GREEN: remove file-store authority from route admission; file operations are forbidden before a PostgreSQL lease exists.
- [ ] Run: `npx tsx --conditions=react-server --test tests/agent/postgres-sync-job-repository.test.ts tests/agent/local-data-bridge.test.ts`
- [ ] Commit only these paths: `feat(concurrency): add atomic fair sync admission`

---

### Task 3: Dispatch Leased Jobs And Preserve Refresh Recovery

**Files**

- Create: `server/runtime/sync-job-dispatcher.ts`
- Create: `server/services/sync-job-worker-handler.ts`
- Modify: `server/agent-service.ts`
- Modify: `app/lib/sync-server.ts`
- Modify: `scripts/lib/sync-job-store.mjs`
- Modify: `app/lib/asin-sync-session.ts`
- Modify: `app/asin-sync-funnel.tsx`
- Test: `tests/agent/sync-job-dispatcher.test.ts`
- Test: `tests/agent/asin-sync-session.test.ts`

**Behavior**

- Run six dispatcher loops, but let PostgreSQL `wholeJobLimit` cap active jobs; heartbeat and generation fencing prevent stale workers from writing.
- Only after claim, create a redacted JSON diagnostic mirror, launch the existing runner, mirror progress to PostgreSQL, and settle every active module on completion/failure.
- Expired leases return to queued with bounded attempts; exhaustion becomes terminal. Restarted Agent Service resumes queued/expired work.
- URL refresh remains GET-only and restores PostgreSQL progress; it must never resubmit POST.

**TDD steps**

- [ ] RED: prove restart recovery, expired-worker fencing, terminal module settlement, and four-job standard cap with six loops.
- [ ] RED: refresh a running URL and assert only GET requests plus the same job ID and queue position.
- [ ] GREEN: implement dispatcher/handler and downgrade the legacy file store to diagnostic read/write only.
- [ ] Run: `npx tsx --conditions=react-server --test tests/agent/sync-job-dispatcher.test.ts tests/agent/asin-sync-session.test.ts`
- [ ] Commit only these paths: `feat(concurrency): dispatch resumable postgres sync jobs`

---

### Task 4: Add Versioned Policy And A Cross-Process Resource Governor

**Files**

- Create: `server/db/migrations/postgres/0012_concurrency_control.sql`
- Create: `server/db/concurrency-control-repository.ts`
- Create: `server/db/postgres/concurrency-control-store.ts`
- Create: `server/concurrency/concurrency-policy.ts`
- Create: `scripts/lib/postgres-resource-governor.mjs`
- Modify: `server/config.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/postgres-repository.ts`
- Modify: `server/runtime/sync-job-dispatcher.ts`
- Modify: `server/connectors/remote-mcp-connector.ts`
- Modify: `server/runtime/openai-provider.ts`
- Modify: `scripts/lib/mcp-json-rpc-client.mjs`
- Modify: `scripts/lib/sorftime-mcp-client.mjs`
- Modify: `scripts/lib/image-remark-queue.mjs`
- Test: `tests/agent/postgres-concurrency-control.test.ts`
- Test: `tests/agent/connector-resource-governor.test.ts`

**Stable interfaces**

- `ConcurrencyControlRepository.getEffectivePolicy(organizationId)`
- `acquirePermit({ resource, jobId, attemptKind, leaseMs })`, `heartbeatPermit`, `releasePermit`
- `recordPhysicalAttempt` records every initial call, retry, probe, and quota refresh.
- Policy rows are immutable versions; a current-policy pointer changes atomically. Migration bootstraps conservative/standard/fast and links new jobs to the effective version.

**TDD steps**

- [ ] RED: two repository instances race for permits and never exceed each resource cap; expired permits recover; rolling SellerSprite attempts never exceed 30/60s.
- [ ] RED: fake parent and child calls prove retries consume separate permits/attempt rows; wait/timeout produces a safe typed error.
- [ ] GREEN: implement profiles, downgrade-only effective policy, PG permits, leases, and rolling-rate admission.
- [ ] GREEN: wrap the actual fetch/SDK call in every listed parent/child integration; keep existing timeout/retry normalization outside the permit.
- [ ] Run: `npx tsx --conditions=react-server --test tests/agent/postgres-concurrency-control.test.ts tests/agent/connector-resource-governor.test.ts`
- [ ] Commit only these paths: `feat(concurrency): govern external requests across processes`

---

### Task 5: Prove The Twenty-User Fake Capacity Tracer

**Files**

- Create: `tests/smoke/twenty-user-concurrency.ts`
- Create: `tests/fixtures/concurrency/fake-provider.ts`
- Modify: `package.json`
- Create: `docs/runbooks/twenty-user-concurrency.md`

**Acceptance evidence**

- Twenty authenticated users submit three distinct ASINs simultaneously.
- All submissions receive a durable job ID promptly; no duplicate active identity, lost job, cross-user data, lease collision, or uncaught 5xx occurs.
- Running whole jobs never exceed 4; SellerSprite/SIF/Sorftime/model/image physical concurrency never exceeds `2/1/1/2/2`; SellerSprite rolling requests never exceed 30.
- Kill/restart the Agent process mid-run; all jobs resume or terminate explicitly, and refresh polling stays GET-only.
- Connection usage stays within the configured pool and all 20 jobs end terminal within the documented fake-provider budget.

**TDD steps**

- [ ] Add `smoke:concurrency:fake` and make it fail on any missing invariant above.
- [ ] Run: `npm run smoke:concurrency:fake`
- [ ] Run twice back-to-back to expose leaked permits, stale leases, and nondeterministic fairness.
- [ ] Record only counts, timestamps, safe job IDs, and pass/fail evidence in the runbook; never provider responses or secrets.
- [ ] Commit only these paths: `test(concurrency): add twenty-user fake capacity tracer`

---

### Task 6: Add SellerSprite Quota, Downgrade, And Primary-Admin Controls

**Files**

- Create: `server/services/seller-sprite-quota-service.ts`
- Create: `server/routes/concurrency-admin.ts`
- Modify: `server/app.ts`
- Modify: `server/http-contract.ts`
- Modify: `server/db/postgres/concurrency-control-store.ts`
- Modify: `app/lib/primary-admin.ts`
- Create: `app/lib/concurrency-admin-browser.ts`
- Create: `app/concurrency-admin-panel.tsx`
- Modify: `app/page.tsx`
- Test: `tests/agent/concurrency-admin-routes.test.ts`
- Test: `tests/agent/concurrency-admin-page.test.tsx`

**Endpoints**

- Read-only admin: `GET /v1/admin/concurrency` returns queue counts, active policy, safe connector health, SellerSprite local attempt count, last `/v1/visits` snapshot, and `总额度未知` semantics.
- Primary-admin only: `PUT /v1/admin/concurrency/policy`, `PUT /v1/admin/seller-sprite/quota/total`, `POST /v1/admin/seller-sprite/quota/refresh`, `POST /v1/admin/concurrency/pause`, and `POST /v1/admin/connectors/:connectorId/circuit/reset`.
- The quota client uses the official SellerSprite `/v1/visits` route through the Task 4 governor. Make host/path configuration explicit and validate the response contract before enabling scheduling.

**TDD steps**

- [ ] RED: member gets 403; ordinary admin reads but cannot mutate; a spoofed client email cannot bypass repository-loaded `admin@example.com` verification.
- [ ] RED: unknown total, warning, conservative downgrade, zero/`ERROR_VISIT_MAX` resource-only pause, manual hold, and non-secret audit events.
- [ ] GREEN: implement scheduled/manual quota snapshots and downgrade/pause reducer; no automatic upgrade or manually held circuit reset.
- [ ] GREEN: render queue/profile/quota/circuit state for admins; show mutation controls only to the primary admin and safe queue messages to members.
- [ ] Run: `npx tsx --conditions=react-server --test tests/agent/concurrency-admin-routes.test.ts tests/agent/concurrency-admin-page.test.tsx`
- [ ] Commit only these paths: `feat(admin): expose concurrency and sellersprite quota controls`

---

### Task 7: Run Final Gates And Staged Real Verification

**Files**

- Modify: `docs/runbooks/twenty-user-concurrency.md`
- Modify only if required by failing evidence: files owned by Tasks 1–6

**Verification sequence**

- [ ] Fresh PostgreSQL: apply migrations through `0012`; run the focused repository, dispatcher, governor, auth, and UI tests.
- [ ] Run: `npm run smoke:concurrency:fake` twice.
- [ ] Run: `npm run test:agent`
- [ ] Run: `npm run lint -- --quiet`
- [ ] Run: `npm run build`
- [ ] Run: `git diff --check` and scan generated logs/job projections for credential, cookie, database URL, and raw upstream leakage.
- [ ] With explicit cost approval and real credentials already configured, verify 1, then 2, then 4 whole jobs. Stop immediately on 429, quota error, circuit opening, elevated terminal failures, or concurrency/rate invariant breach.
- [ ] Verify service restart, browser refresh GET-only recovery, primary-admin mutation audit, ordinary-admin read-only behavior, and member tenant isolation.
- [ ] Document exact commands, timestamps, observed maxima, quota source/age, rollback steps, and any deferred production work. Do not claim 20-user real-provider capacity from fake evidence.
- [ ] Commit only verified corrections/runbook evidence: `docs(concurrency): record staged acceptance evidence`

## Execution Order And Review Gates

1. Tasks 1–3 form the runnable PostgreSQL queue tracer and may be reviewed together only after each has its own commit.
2. Tasks 4–5 prove bounded 20-user fake capacity before any quota UI or real-provider testing.
3. Task 6 adds quota and administrator operations only after the governor is proven.
4. Task 7 is the release gate. Do not merge if PostgreSQL is unavailable, any stage remains permanently active, refresh emits POST, limits are exceeded, or secrets enter logs/HTTP.

## Plan Self-Review Checklist

- [ ] Every required design decision maps to a task and test.
- [ ] PostgreSQL, not SQLite/JSON/process memory, owns every concurrency fact.
- [ ] All physical request paths, including child processes and retries, use the same governor.
- [ ] Twenty-user evidence is fake-provider evidence; real verification remains staged and cost-controlled.
- [ ] Server-side primary-admin authorization and append-only audit are explicit.
- [ ] Each task has exact paths, RED/GREEN commands, a scoped commit, and preserves unrelated WIP.
