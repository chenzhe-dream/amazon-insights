# Germany and Canada Analysis Implementation Plan

> Execute using test-driven development and subagent-driven-development, with source ownership separated below and final integration reviewed before live acceptance.

**Goal:** DE/CA task creation, scoped collection, and persisted real analysis in isolated candidate 33900/33901.

**Architecture:** Extend formal 7efbc72a project/sync/analysis pipeline and keep existing scoped source provenance. Candidate uses independent database, data, runtime, cookies and ports.

**Tech Stack:** TypeScript, Node test/tsx, PostgreSQL, vinext/React, Sorftime/SIF providers, existing model runtime.

## Global Constraints

- Preserve production 31900/31901 and existing candidate 32900/32901 processes, code, data and runtime.
- Use US, UK, DE, CA project identities; verify provider-specific codes, currency and domains.
- Keep organization/project/marketplace/ASIN scope exact; never seed non-US collection from US cache.
- Keep legacy/manual Alexa US-only; use explicitly labelled review fallback for DE/CA VOC analysis.
- Unknowns remain unknown; actual missing, unsupported, failed and empty results remain visible.
- Do not claim acceptance readiness without real DE and CA creation, collection, model output and persisted readable reports.

## Tasks and ownership

- [x] 1. Contract and queue: shared project marketplace definition, registration/response contracts, repository project and sync types, PostgreSQL sync migrations and queue parsing. Add failing DE/CA contract/admission regressions, implement changes, run targeted project/sync/database tests. Owner: contract implementer. Files: shared/agent-contracts.ts, shared/project-marketplaces.ts, server/db/repository.ts, server/db/sync-job-repository.ts, server/db/postgres/sync-job-store.ts, new postgres migration, server/services/sync-job-service.ts, corresponding tests. No analysis source or collector changes.
- [x] 2. Collection: audit scripts, provider mappings, worker publication and site-scoped readiness for DE/CA; add dispatch/output regressions then implement correct site/currency/source handling. Owner: collection implementer. Files: scripts/, server/services/sync-job-worker-handler.ts and provider collection services, matching tests. No contract or database edits without coordination.
- [x] 3. Analysis: enable supported DE/CA snapshot and review-fallback model workflow with exact project/site/source scope, retaining US manual vault boundaries. Audit source inventory, runtime/schema/report and UI restrictions; add failing regressions and implement. Owner: analysis implementer. Files: shared/voc-evidence-contracts.ts, shared keyword/VOC snapshot contracts where necessary, server/services/analysis-run-service.ts, server/services/voc-evidence-inventory-service.ts, server/data/, relevant runtimes and UI. Coordinate needed shared/agent-contracts.ts edits with task 1.
- [x] 4. Candidate isolation: record baseline fingerprints/PIDs; create independent candidate database/data/runtime and launcher; seed existing credentials/account only within the isolated candidate; run necessary migrations. Owner: root.
- [x] 5. Review/integration: inspect each task, fix material findings, run relevant combined tests, typecheck and production build. Owner: root plus reviewer.
- [x] 6. Live acceptance: start only 33900/33901; create DE and CA projects via public task APIs, collect actual data and run actual model analysis; verify persisted output, source gaps and report UI; produce an acceptance record with URLs, IDs, pass/fail evidence and before/after baselines. Owner: root. Evidence: docs/verification/2026-10-21-de-ca-candidate-acceptance.md; four real-model stages and persisted reports passed, public idempotency replay and saved report pages verified, prior environment identities unchanged.
