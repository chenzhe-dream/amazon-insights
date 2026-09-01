## Context

See `proposal.md`. The current catalog fallback successfully receives Sorftime `product_detail` but projects it directly into `competitor-data.ts`, retaining only the first image and display text. Later builders are separate processes that call the provider again; after provider degradation they have neither the original response nor a scope-safe fallback. Image remarks only reads the listing gallery. Environment credentials are resolved by the server but the primary-admin UI intentionally disables managed editing for that source.

## Goals / Non-Goals

**Goals:**

- Recover the acceptance path with a bounded same-job evidence seam and no new external dependency.
- Keep evidence identity and outcomes explicit enough to reject stale cache and distinguish verified empty from transport failure.
- Make gallery readiness and image analysis progress idempotent and truthful.
- Make environment-to-managed credential switching explicit, secret-free, and operationally clear.

**Non-Goals:**

- No generic provider platform, database/project migration, live-provider repair, deployment, or change to administrator-center/read-only-history behavior. Historical recovery is limited to the six named ASINs and seven proven exports.
- No fabrication of category trends, child sales, or image analysis when the required evidence does not exist.
- No real provider or paid model call in tests.

## Decisions

### 1. Use a bounded per-job Sorftime evidence file

Successful Sorftime operations invoked with a sync job identity will write an atomic, permission-restricted record under the shared runtime data directory. The envelope contains schema version, job ID, marketplace, ASIN, fetchedAt, operation, source `Sorftime`, provenance, and only operation-specific allowlisted fields. Readers require exact envelope matches and reject malformed, mismatched, or missing evidence.

This is preferred over adding raw responses to generated TypeScript or PostgreSQL: raw responses would leak unrelated fields, generated files have no job identity, and a migration is outside this repair slice. Tests redirect the evidence directory to a temporary directory.

### 2. P0 consumes retained product-detail gallery before another network call

The catalog Sorftime fallback retains the normalized full gallery. The listing builder first checks matching current-job evidence, then performs its existing provider call only when evidence is insufficient. Gallery output retains main and auxiliary image ordering plus provenance. After listing persistence, the runner changes image remarks from a terminal gap to pending only when listing is now ready; the pending state itself is the idempotency guard, so repeated reconciliation does not reactivate it.

The image queue continues its existing per-image concurrency and outcome isolation. UI completion is derived from analyzable gallery slots, never from a zero-image denominator or catalog main-image fallback.

### 3. P1 adds module-specific evidence adapters only

FBA, Listing, price strategy, category identity/trend, and child sales each get a small adapter for the evidence they already consume. Precedence is: usable normal result, exact current-job evidence, verified empty, connector failure. Existing legacy cache may remain for manual non-job commands, but a current sync job cannot label legacy cache as its current result. Category trend and child sales become ready only when their required operation evidence exists; product detail alone can supply category identity but not fabricated trend points.

This is preferred over reordering all provider stages or weakening the provider circuit breaker because both would mask the loss boundary and broaden risk.

### 4. Recover sealed historical exports with a prevalidated missing-only plan

The recovery command reads only `C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\backups\pre-switch-20260901-123942574`, verifies each relevant source file against the backup manifest SHA, and constructs the complete merge plan before writing. It selects the six named lighting ASINs from catalog, SIF keyword, listing traffic, monthly traffic, Sorftime review, and Sorftime rating exports. SIF enrichment selects only keywords referenced by those six keyword records. Existing canonical keys always win, including enrichment collisions; no sales, child, price, FBA, category, listing, image, variant, or VOC result is restored.

The recovery manifest records source file/export/SHA, requested ASINs, inserted and preserved key counts, post-merge coverage, excluded semantics, and a digest of the existing six shelf-light records. It contains no credential or business payload. The generated TypeScript export initializer is replaced semantically rather than copying a backup file, so canonical-only records and concurrent P0 changes remain intact.

The current formal launcher still constructs Web publication storage under `data/web-runtime-artifacts` inside its code worktree, and its artifact store enforces that containment. Moving that store to the external runtime root would change launcher recovery and security invariants shared with the synchronization window, so this bounded recovery does not alter it. The direct loss blocker here is instead removed by committing the recovered generated exports on the canonical-derived branch together with a reproducible, SHA-verified recovery command; publication-root externalization remains a separate coordinated change.

### 5. P2 keeps managed credential precedence and makes the switch explicit

The existing credential service resolves an active managed version before environment fallback and its rotation API can create a managed version even when the safe state currently reports `environment`. The UI will expose a confirmation-controlled “switch to managed” action for primary administrators, use a password input held only in component state, clear it after submission, and immediately probe. Safe response types remain metadata-only.

The formal configuration path is `C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\formal-stack.env`. If the environment source remains active, the card shows this path and the connector variable name plus “restart formal stack, then probe”; a managed save used by runtime resolution requires no process restart and only the immediate probe.

## Risks / Trade-offs

- [A process crashes between provider success and evidence write] → The existing stage reports a connector gap; it never invents a fallback.
- [Evidence files accumulate] → Keep them job-scoped and eligible for bounded cleanup after terminal publication; cleanup is deferred if it would alter the current acceptance path.
- [A product-detail response lacks fields required by a module] → Publish verified empty only with operation evidence; otherwise preserve connector failure.
- [Managed credentials do not reach a legacy subprocess] → Focused tests must prove new runtime resolution/injection for each connector before the UI claims no restart.
- [A backup or canonical source changed] → Reject the entire recovery before any write when manifest SHA, export shape, requested coverage, or preserved-baseline digest is invalid.

## Migration Plan

No database or project migration is required. The one-time generated-result recovery performs only prevalidated missing-key inserts into seven exports and emits a recovery manifest; it does not overwrite canonical records or reinterpret missing statuses. Deploying the runtime code affects only new jobs. Rollback of runtime behavior removes the new readers and UI action while leaving evidence files ignored and unused; the recovery commit can be reverted independently if necessary.
