## Context

See `proposal.md`. The current catalog fallback successfully receives Sorftime `product_detail` but projects it directly into `competitor-data.ts`, retaining only the first image and display text. Later builders are separate processes that call the provider again; after provider degradation they have neither the original response nor a scope-safe fallback. Image remarks only reads the listing gallery. Environment credentials are resolved by the server but the primary-admin UI intentionally disables managed editing for that source.

## Goals / Non-Goals

**Goals:**

- Recover the acceptance path with a bounded same-job evidence seam and no new external dependency.
- Keep evidence identity and outcomes explicit enough to reject stale cache and distinguish verified empty from transport failure.
- Make gallery readiness and image analysis progress idempotent and truthful.
- Make environment-to-managed credential switching explicit, secret-free, and operationally clear.

**Non-Goals:**

- No generic provider platform, migration, live-data repair, deployment, or change to administrator-center/read-only-history behavior.
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

### 4. P2 keeps managed credential precedence and makes the switch explicit

The existing credential service resolves an active managed version before environment fallback and its rotation API can create a managed version even when the safe state currently reports `environment`. The UI will expose a confirmation-controlled “switch to managed” action for primary administrators, use a password input held only in component state, clear it after submission, and immediately probe. Safe response types remain metadata-only.

The formal configuration path is `C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\formal-stack.env`. If the environment source remains active, the card shows this path and the connector variable name plus “restart formal stack, then probe”; a managed save used by runtime resolution requires no process restart and only the immediate probe.

## Risks / Trade-offs

- [A process crashes between provider success and evidence write] → The existing stage reports a connector gap; it never invents a fallback.
- [Evidence files accumulate] → Keep them job-scoped and eligible for bounded cleanup after terminal publication; cleanup is deferred if it would alter the current acceptance path.
- [A product-detail response lacks fields required by a module] → Publish verified empty only with operation evidence; otherwise preserve connector failure.
- [Managed credentials do not reach a legacy subprocess] → Focused tests must prove new runtime resolution/injection for each connector before the UI claims no restart.

## Migration Plan

No data migration is required. Deploying the code affects only new jobs; old generated WIP and historical jobs remain unchanged. Rollback removes the new readers and UI action while leaving runtime evidence files ignored and unused.
