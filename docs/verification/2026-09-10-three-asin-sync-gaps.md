# Three-ASIN sync diagnostic and repair (2026-09-10)

## Scope and evidence

Independent worktree: `C:/Users/EDY/.codex/worktrees/adda/feat-voc-positioning-skill-execution`.
Baseline fast-forwarded from `9690ab5` to `3c860d3cdbaee5d0686bf0d43718f61891c2452f`, including formal `4bb38d9` and its exact Sorftime no-data handling. No pre-existing uncommitted changes; no applicable nonempty AGENTS.md found. Existing node_modules reused through a junction; no installs/upgrades.

Latest real US job containing all three requested ASINs: `2f37a6e3-5ef0-4561-a6dd-359096876b72`, created `2026-09-10T03:53:19.166Z`, completed at version 11, updated `2026-09-10T03:56:14.789Z`.
Evidence: read-only PostgreSQL job/stage gaps, its existing mirror diagnostics, generated module summaries, and 10 bounded physical diagnostic requests through the existing PostgreSQL resource governor against this real job/organization. Each diagnostic fetch had a 20-second AbortSignal; no retry loops, batch replay, fabricated jobs, or governor bypass. Two repeated SIF requests refined safe message classification. Credentials remained in memory; no raw provider bodies or personal reviews were printed/saved. Governor permit/attempt accounting was the only intended database write; no job/module/output/artifact edits.

## Module/ASIN causes

| Module | B09NNDX731 | B0BHHP21DP | B0CZRBL776 |
| --- | --- | --- | --- |
| keywords | Ready | Exact SIF `no data returned for this asin/period` message-only envelope rejected for missing top_keywords | Same exact no-record envelope, independently verified |
| reviews | Ready | Ready | product_reviews returns exactly `No reviews found.`; rejected at tool-content JSON parsing |
| child_sales | One recognized row, SalesAmount=-1, no usable sales; must remain unavailable | Recognized empty variations in persisted builder outcome | Exact `No data available.` variations, independently verified; existing outcome already verified-empty |
| price_strategy | Ready, current price 59.99 | product_detail price=0; existing positive-money guard excludes it | product_detail price=0; existing positive-money guard excludes it |
| fba | Ready, 11.42 | Ready, 8.40 | product_detail fba_fee=0; existing positive-money guard correctly produces empty/null |
| category | Ready | Ready | Valid identified product_detail object with node_id=""; consumer incorrectly labels missing category node MCP_SCHEMA |
| traffic | Module ready; cached raw overview total >0 and 3 dimensions, but final output incorrectly lists it as UPSTREAM_EMPTY | Raw overview total=0; no usable traffic | Raw overview total=0; no usable traffic |

The original child_sales MCP_SCHEMA for B0CZRBL776 is from the auxiliary variation-review builder's **product_reviews** call, not product_variations. The orchestrator merges that diagnostic when the child-sales process exits nonzero (B09NNDX731's unusable -1 row causes the batch's schema-error outcome). The exact no-review normalization removes this observed spurious error without creating sales. The internal child-sales outcome still labels the -1-only row `schema-error`; its persisted module remains UPSTREAM_EMPTY. Do not interpret it as transport/schema drift or usable zero sales.

Original mirror providerDegraded=[]; persisted diagnostics contain only the two product_reviews schema errors (reviews/child_sales) and product_detail category error. No HTTP/RPC error or breaker-induced skip was found in this job. Upstream absence is current evidence, not a guarantee the vendor never has records.

## Changes

1. `cfbb797`: narrowly accept Sorftime product_reviews exact no-review text and SIF's exact two-field no-record envelope. Reject unknown/conflicting fields and preserve explicit SIF tool errors as RPC failures. A matching product with explicit empty category node becomes an empty category record; missing/malformed identity remains schema failure. No shared generic non-JSON swallowing and no ASIN-specific production behavior.
2. Stage projection fix: when finalizing a subset, include previously ready siblings from current job module state and retain bounded same-stage sibling diagnostics/previous gaps. This corrects the final traffic snapshot's lost first ASIN. Refreshed ASINs do not inherit their stale gaps.

## Verification

- Red first: three no-record classifier tests failed with existing schema errors; explicit SIF tool-error rejection failed; sequential traffic test reproduced a ready ASIN turning into UPSTREAM_EMPTY and an earlier schema cause disappearing.
- Final targeted regression: **142/142 pass**, Node test runner across 13 parser/provider/builder/stage suites.
- Production review CLI runs with isolated temporary files and a loopback fake provider. No-review result remains missing/pending (not verified zero total reviews), while a ready sibling remains byte-equivalent. Existing verified-zero and empty-summary-with-valid-reviews cases still pass.
- Category empty+successful sibling test preserves the successful trend and emits no false schema diagnostic.
- Traffic test runs real postcondition/projection code: prior successful numerical data survives, earlier bounded failure reason survives, current empty ASIN remains UPSTREAM_EMPTY.
- Targeted ESLint on all changed JS files passes. `git diff --check` passes. No full web build or formal deployment claimed.

## Coordinator review / remaining limits

Existing formal version-11 job and published data are untouched: code fixes alone will not rewrite those persisted gaps. Any scoped maintenance or deployment remains the coordinator's decision. Do not mark the upstream-empty modules done, invent zero prices/fees/sales, or claim 100% coverage.

Suggested display wording only (no app/page.tsx change): keywords “所选时段暂无关键词记录”; reviews “上游暂无评论样本”; category “上游未提供类目节点”; stale child sales “暂无可核验的近期子体销量”. Traffic stage detail still describes the last per-ASIN cohort (1/1); a future display/count adjustment should use the full job cohort.

No subagents/new tasks, formal service changes, restart, publication, push, job repair or user-data deletion. Main coordinator should review/integrate these small commits, especially the shared stage-projection change.
