# Sorftime explicit-empty response repair

> **For agentic workers:** Use executing-plans for inline execution. The site owner edits the existing isolated worktree; use a read-only reviewer before release.

**Goal:** Recover usable Govee reviews and correctly disclose unavailable child sales without disturbing successful sibling ASINs.

**Architecture:** Normalize only two observed Sorftime tool-specific empty messages before the strict shared MCP normalizer. Existing review transformation can consume reviews without Customers Say. Keep empty child sales a partial data gap, not a zero-sales result. Render the child-sales notice compactly with explicit retained-data wording.

**Tech Stack:** Node ESM, React/TypeScript, PostgreSQL, existing managed Windows formal stack.

## Evidence and design review

Governed live probes on 2026-09-10 for US B0F43M9KWW returned:
- product_customers_say: `{content:[{type:"text",text:"No relevant data."}]}`.
- product_variations: `{content:[{type:"text",text:"No data available."}]}`.
- product_reviews: valid JSON with a nonempty `data` array.

The first two strings fail the current JSON-only normalizer. Promise.all then drops the valid reviews result. This is not an observed timeout. Keep generic MCP parsing strict; do not globally treat non-JSON strings as empty. Unknown text, mixed content, explicit tool errors, and unrecognized operation/message pairs must remain errors. No ASIN-specific production branches.

## Global constraints

- Only repair reviews and child_sales for the current failed Govee record; no full analysis run.
- Preserve other two ASIN records, all VOC revisions, all other stage outputs, project ownership and credentials.
- Source: fix-voc-import-status-20260907; formal: integrate-xydc-variant-20260905; no OpenSpec checkout edits.
- Keep local/LAN managed deployment. No dependency, schema, authentication or permission changes.
- No synthetic reviews or zero sales, no disguising missing data as complete.

## Task 1: Tool-specific normalization

Files: scripts/lib/sorftime-mcp-client.mjs; tests/scripts/sorftime-empty-response.test.mjs; tests/scripts/sorftime-review-verified-empty.test.mjs.

- [ ] Add failing tests calling the real client with fixture HTTP responses for both exact observed messages; assert Customers Say projects to `{details:[]}` and variations to `{data:[]}`.
- [ ] Add production review-builder integration fixture: empty Customers Say plus one valid review produces ready status and retains an unrelated sibling record byte-for-byte at object level.
- [ ] Test unknown text, wrong operation, extra content, and isError remain rejected, and empty source data is not a zero-sales row.
- [ ] Implement `normalizeSorftimeToolResult(toolName,result)` with strict operation/message pairs, single text block, no structuredContent, no true isError. Delegate other inputs to normalizeMcpResult. Explicit isError raises bounded RPC transport error.
- [ ] Run `node --test tests/scripts/sorftime-empty-response.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs tests/scripts/sorftime-child-sales-parse.test.mjs tests/scripts/sorftime-category-retry.test.mjs`.

## Task 2: Compact partial child-sales notice

Files: app/stage-output-gap-card.tsx; tests/agent/stage-output-gap-card.test.tsx.

- [ ] Add real server-render tests: child_sales partial rows and one gap show per-ASIN reason with retained-data text; no pending-box or card. Missing/failed outputs and other stage layouts remain unchanged.
- [ ] Use existing stage-output-gap-notice styling, role=status; no new dependency or page layout changes. UPSTREAM_EMPTY copy says the source has no usable data, not that sales are zero.
- [ ] Run `npx tsx --test tests/agent/stage-output-gap-card.test.tsx tests/agent/stage-output-gap-notice.test.tsx` and existing traffic regression suite.

## Task 3: Review, local release, current-record recovery

- [ ] Run build and read-only code review. Review regression gates including malformed-input rejection and sibling preservation.
- [ ] Fresh idle-queue gate, exact dirty-file snapshot, DB dump, config/project/artifact backup; commit only scoped changes and integrate without touching generated dirty data.
- [ ] Managed PublishCode; verify both code identities and local/LAN health plus unchanged data pointer for code-only release.
- [ ] Recover current Govee record from governed calls using the fixed normalizer. Existing public resume currently only accepts category/build recovery; do not broaden that interface or silently invoke a full run. Use a bounded maintenance repair with exact job/project/run/ASIN identity, expected versions/hashes, transaction and before/after fingerprints. Preserve sibling data and all unrelated outputs; stop on active lease or version conflict.
- [ ] Verify persisted reviews available, child_sales partial UPSTREAM_EMPTY, and Govee absent from child-sales rows; verify all unrelated stage hashes and VOC versions unchanged. Refresh existing project, not a new demo page.

Self-review: scope addresses source classification and lost reviews; no fake completion. Current persisted gap needs an explicit data repair as well as deployment. Unknown future provider responses remain fail-closed. User previously authorized self-review then implementation without another approval round.

## Execution record

- Tasks 1 and 2 implemented and verified after red tests. 25 script tests + 9 component tests passed; full regression 36 script + 62 service/browser tests passed; production build passed.
- Read-only code review approved. Reviewer broad rerun had one VOC fixture setup timeout (61/62) before identity assertions; isolated retry passed. Main broad run was clean. Minor test wording corrected.
- Live recovery preparation uses fixed client and returns 33 Govee review samples. Child sales remains explicit empty, never 0.
- Exact-job maintenance proposal validated against public projection contract. Default apply-script rollback rehearsal passed, retaining 8 unrelated stage outputs, all sibling module records and 27 VOC heads/revisions.
- Fresh formal backup: sorftime-empty-response-20260910-113029; queue idle, 15 generated files and 29 project files protected; PostgreSQL backup completed.
- All tasks completed: formal code publication verified at 4bb38d9; exact-job maintenance applied at 11:41:32 after review and rollback rehearsal. Live store/browser-owner verification shows reviews 3/3 (33 Govee samples) and child sales 2/3 UPSTREAM_EMPTY. See docs/verification/2026-09-10-sorftime-empty-response-repair.md for release identities, preserved-data fingerprints and scope limitations.
