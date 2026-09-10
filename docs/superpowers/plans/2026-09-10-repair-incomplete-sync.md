# 补抓未完成 Implementation Plan

> For agentic workers: use subagent-driven-development for bounded independent components and review, with local integration.

**Goal:** Replace the terminal restart action with a server-authorized repair of incomplete ASIN/module cells without deleting valid caches or manual VOC.

**Architecture:** The existing sync start endpoint accepts `mode: repair-incomplete` and `parentJobId`. The backend validates the parent scope and persists a repair plan in stage metadata (`repairAsins`, `repairParentJobId`), using the existing admission, leases, projections and publication pipeline. The runner limits each invocation to those targets and bypasses only their incomplete cache records. New runs keep old reports historical.

**Tech Stack:** TypeScript, Fastify/Zod, PostgreSQL sync queue, Node collection scripts, React.

## Global Constraints
- Preserve working-tree changes removing manual Alexa VOC from gap lists.
- Never mutate formal runtime, production data, credentials or another worktree.
- No global cache deletion or blanket force refresh. No manual VOC collection.
- Reuse active same-scope jobs through existing admission fingerprint.
- Preserve cancellation/lease fencing and validated existing data on failed refresh.
- Reuse existing completeness predicates; legal upstream-empty may be retried once per user action.

## Tasks
- [x] Backend: add strict repair request fields; validate parent organization/project/marketplace/ASIN set, use current readiness to construct per-stage targets, persist metadata, return explicit no-work response without admitting a job. Test scope rejection, ready-cache exclusion and duplicate admission behavior.
- [x] Runner/cache: select stage-specific ASINs; retry unavailable caches with a repair-only policy; do not force complete subrecords; finalize cached siblings truthfully; preserve existing valid records when provider calls fail. Test target isolation, partial recovery and failure preservation.
- [x] UI: terminal button becomes 补抓未完成; POST mode/parent identity; handle no-work result without losing terminal context, retain duplicate guards and normal initial sync behavior. Test request construction and no-work behavior.
- [x] Integration: relevant contract/service/runner/UI tests, build, diff validation, independent review; record limitations and delivery evidence.

## Verification commands
Run targeted tests with `npx tsx --conditions=react-server --test <test-file>` and `node --test <script-test-file>`. Run `npm run build` after integration. No live provider or production writes are required for verification.
