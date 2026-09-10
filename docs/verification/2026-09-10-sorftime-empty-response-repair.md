# Sorftime no-data classification and Govee recovery

## Root cause

Live governed probes for US B0F43M9KWW confirmed Customers Say returns the text `No relevant data.` and variations returns `No data available.`. The shared JSON-only parser rejected these at tool-content. Review Promise.all consequently discarded the other valid response: product_reviews.

The repair is Sorftime/tool specific and has no ASIN-specific production branches. Explicit tool errors remain errors, unknown/mixed/structured-content conflicts remain fail-closed. Shared transport parsing is unchanged. Empty variations never create zero-sales rows.

## Release

- Formal source commit: `4bb38d966787de7216ec4aae96a945a0c0a5a4f1`.
- Source hash: `9900b4c991a2fb033d3d1cee5b64fbcd800207e7908ae0d648a588ef6f6daeae`.
- Code artifact: `9062b426bcc6ebbd9a84a446ad117c21bc5b41de4542016197bc000bcf477ec9`.
- Existing data artifact retained: `eb57be6d5bce3fe92f1b24be6752c5602539d82e2c3409b591d8093c322ace34`.
- Managed PublishCode completed; Web local/LAN and Agent health all report the same new code identity. PostgreSQL host listener remains 51004.
- 45 protected files (15 generated, 29 projects, configuration) remain byte-identical to backup. The old flat data pointer was moved into dataCurrent by normal code publication; artifact/job/version/stage hashes/storage identity remain the same, not a data replacement.

## Current-task repair

- Job `fa6491c5-b66c-49e5-a76f-34aacddcf83c`, run `dabb5d31-4385-4bc6-9151-ab80d280cf43`, project `dfc28512-d7c2-4308-9c58-efe6d3e1769c`.
- Applied 2026-09-10 11:41:32 Asia/Shanghai; job version 11 -> 12.
- Reviews now done, 3/3; Govee restored 33 real review samples. Review source summary is still unavailable; positive/negative/unmet blocks are not invented. Existing transform preserves supported consumer/scenario/motive evidence.
- Child sales stays partial, 2/3; Govee gap UPSTREAM_EMPTY. Its absent rows do not represent zero sales. Compact per-ASIN notice replaces only the partial child-sales gray card.
- Other 8 stage outputs, all sibling module records, 27 VOC heads and 27 revisions remain unchanged.
- No full batch rerun, no queue/lease fabrication, no public resume-policy widening, no generated source rewrite, no historical artifact rewrite. The current browser receives the versioned repair through existing scoped stage-output reads.

## Safety and verification

- Exact owner/job/project/run/ASIN binding, current completed/unleased job, idle queue, before-state fingerprints, row locks and output contract/hash validation.
- Default maintenance invocation performs a SERIALIZABLE rollback rehearsal. Real apply backed up original mirror and candidate, then atomically updated two module records, two outputs and job metadata with version increments; mirror uses compare-and-swap.
- Commit-error recovery fences the original transaction with the same job row lock on a fresh connection, holds it across before/after comparison and mirror restoration; unknown state stops with reconciliation evidence.
- Backup directory: `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/sorftime-empty-response-20260910-113029` (PostgreSQL dump, protected files, candidate, original mirror, repair receipt and maintenance scripts).
- Tests: 25 provider/parser/production-builder tests; 9 component tests; 36 pipeline + 62 service/browser regressions; build passed. Separate maintenance classifier 3 tests and rollback rehearsal passed. Reviewer approved code and final maintenance script.
- Reviewer broad concurrent rerun had one VOC fixture setup timeout (61/62); isolated retry passed. Main full run was clean. Existing TypeScript error remains in an unchanged older fixture declaration at stage-output-gap-card.test.tsx:27; no clean full typecheck claimed.
- Post-apply read through PostgresSyncJobStore and browser owner accepted both new output hashes. Rendering the actual repaired child-sales projection yields the compact no-data notice and no MCP_SCHEMA/pending-box. This is persisted-data/component verification, not a claim of controlling the user's live tab.

Local audit scripts (not runtime features): `test-results/prepare-govee-repair.ts`, `apply-govee-repair.ts`, `commit-resolution.mjs`, `commit-resolution.test.mjs`, `verify-govee-repair.ts`, `verify-sorftime-code-release.ps1`. They intentionally reject replay against changed job versions. Do not reuse the fixed job-specific maintenance script for other tasks.
