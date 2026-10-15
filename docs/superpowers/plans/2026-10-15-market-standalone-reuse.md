# Independent market query repair

**Goal:** Apply the approved history-first and explicit-refresh behavior to standalone keyword and customer-theme entry points, preserve yesterday's work in Git, and deploy only to 32900.

**Architecture:** Reuse the linked flow's validated, organization-scoped history selection with the standalone request's complete parameters and versions. Introduce durable query receipts and a transaction-scoped lock so parallel clicks and retries do not create duplicate jobs. Refresh boundaries are committed atomically with new runs. Browser responses must match submitted scope/parameters; old reports retain their identity and source dates.

**Tech stack:** TypeScript, React, Fastify, Zod, PostgreSQL, node:test and isolated Playwright fixtures.

## Constraints
- User approved implementation on 2026-10-15. No additional feature or UI design is required.
- Closed-month saved reports follow linked history semantics; source-cache TTL applies to recollection, not historical reads.
- Preserve all existing candidate changes, including collector/pending-files; ASIN implementation is already in the base.
- Never call real MCP during synthetic validation. Do not publish 31900 before user accepts 32900.
- New commits must exclude generated compiler state, runtime data, credentials and test artifacts.

## Tasks
- [x] Add failing regressions for standalone ordinary query, parameter/site isolation, concurrent commands, idempotent refresh, refresh source boundary, and usable older results. Version matching reviewed against exact SQL comparisons.
- [x] Share history matching; add query schemas, migration 0068, service methods, API routes and BFF contracts.
- [x] Connect both UI entry points to the server query and verify returned identity; retain historical reports on refresh failure.
- [x] Update browser fixtures for the new contract; investigate the cancellation timing failure without masking it.
- [x] Run targeted regressions, full synthetic 150+10 scenario, typecheck, build and diff checks.
- [x] Save candidate changes and this fix in Git; back up and update 32900/32901, verify matching identities.
- [ ] Verify historical UI on the deployed 32900 after user login (both Chrome tabs currently show login).
- [ ] User acceptance of 32900; 31900 remains pending.
