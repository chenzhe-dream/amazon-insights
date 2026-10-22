# German manual Alexa VOC import repair

Approved scope: repair the manual VOC chain with Germany as the first acceptance target. Shared contracts use US/UK/DE/CA, but only verified sites may be reported as live accepted. Keep formal 31900/31901 and the main thread's candidates untouched.

**Goal:** DE reports can be submitted, normalized if necessary, persisted, read after refresh, and consumed by subsequent VOC analysis.

**Architecture:** Carry the project's marketplace through the existing authenticated pipeline. Preserve organization/project/run/ASIN checks, cutoff semantics, encryption AAD, idempotency and immutable provenance. Legacy static US records remain US-only. New database migration expands manual tables without rewriting history.

**Tech stack:** TypeScript, React, Fastify, PostgreSQL, node:test.

## Tasks

- [x] Add regression tests reproducing DE rejection in contracts, status client, submission, encrypted storage and display. Baseline: 50 existing client/service tests pass. Run with `node --import tsx --conditions=react-server --test tests/agent/manual-alexa-voc-marketplaces.test.ts` and require behavioral failures before code changes.
- [x] Update shared contracts and repository types using ProjectMarketplaceSchema; update security identities and PostgreSQL validation. Add 0073 migration for the four manual VOC tables. Keep US legacy binding scoped.
- [x] Propagate marketplace through app/alexa-voc-import-panel.tsx, app/manual-alexa-voc-store.ts, app/use-manual-alexa-voc.ts, app/lib/alexa-voc-normalization-status-client.ts and the import route. Reject missing market, foreign response records and scope mismatches; retain pasted drafts on failure.
- [x] Update normalization fingerprints/runtime/recovery, publication projection paths and repository-voc-source.ts. Ensure DE evidence never reads US fallback and published snapshots carry the trusted project market.
- [x] Run affected node tests, typecheck and production build. Add focused PostgreSQL integration verification with a dedicated candidate database and actual service roundtrips, including repeat import, cross-market denial and cutoff source consumption.
- [x] Start isolated candidate on available ports; use only clearly labeled test reports if original report text is unavailable. Distinguish fixture verification from the user's actual reports. Record service identities, Git commit and remaining acceptance gaps. Do not deploy formal until acceptance.

## Acceptance and rollback

DE target ASINs: B09Q8MJP3R, B09GY72DX2, B09VP9LJQX, B0GCNJJDZP, B07KSDSSS1. Each must retain DE identity end-to-end. Verify strict parsing and queued normalization separately. Check US compatibility and supported-site isolation. Pending status alone is not successful import. Preserve unknowns and partial evidence.

Commit an explicit file allowlist. Candidate uses its own data/runtime/database. Stop only its owned process when necessary. Additive database constraints may stay expanded if application code rolls back; non-US import must then be disabled, and existing data retained.

## Acceptance status

Candidate implementation, synthetic verification and live normalization of the user's B09Q8MJP3R original report are complete. Seven dimensions survive browser refresh and downstream source consumption passes. Four other user reports and formal deployment remain pending; see the verification document for inherited data-quality limitations.
