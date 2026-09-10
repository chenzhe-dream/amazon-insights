# Full-cohort counts, recovery regression and read-only repair preview

Follow-up to `cfbb797` and `b1bfab5`. Independent worktree only; no subagents or new tasks. All file edits used apply_patch. No provider probes were made in this follow-up.

## Stage detail and recovery behavior

The postcondition now takes one current-job snapshot after updating the processed ASINs and counts the full job's same-stage module states. The detail includes ready/total, upstream-empty, failed (including timeout), and pending counts. For example, a ready ASIN plus an empty ASIN plus a failed ASIN shows:

`1/3 个 ASIN 的 traffic 已就绪 · 上游无结果 1 · 失败 1 · 待处理 0`

An explicit stageDetail still takes precedence (e.g. detailed image progress). An unavailableReason, when supplied without stageDetail, is retained before the cohort summary. Jobs without a current snapshot retain the existing local fallback. No aggregate status or gap completion semantics were changed: all-empty remains partial, all-ready becomes done.

Tests cover all six completion orders; ready/empty/failure/timeout combinations; pending siblings; all-ready/all-empty; a single-ASIN repair from failure to success; a previously ready ASIN becoming failed then empty; and a subsequent sibling completion. They assert retained numerical sibling data, exact gap items and reasonCode, not just strings.

An additional red test exposed old historical schema diagnostics reappearing after failure -> upstream-empty -> another ASIN completion. Historical diagnostics are now eligible for a projection only when that ASIN's current same-stage module state is still connector-failed or timeout. Recovery to ready or upstream-empty cannot resurrect the old active error. Historical job diagnostics remain audit history; the active projected gap contains no obsolete diagnostic. Display code should use the current module/gap state, not treat the mere presence of a historical diagnostic as a current failure.

Verification: **156/156** targeted tests pass (the earlier 142 plus 14 new cohort/recovery cases). Changed-file ESLint and git diff --check pass. Red failures were observed before both the count correction and the historical-error eligibility fix. No full web build or deployment was performed.

## Read-only v11 preview

Run from this worktree:

`node scripts/diagnostics/preview-three-asin-sync-repair.mjs`

This fixed-job diagnostic has no apply mode, file writes, or provider calls. Credentials are read into memory. PostgreSQL uses default_transaction_read_only=on, a REPEATABLE READ READ ONLY transaction, a 10-second statement timeout and a 5-second connection timeout, then ROLLBACK. Only bounded gaps, hashes and traffic score metadata are printed. It refuses changed versions/scopes/artifact bindings/source fingerprints. Both the source fingerprint and mirror bytes are checked again before producing the report.

Verified during this follow-up:

- Job: `2f37a6e3-5ef0-4561-a6dd-359096876b72`; completed, version **11**, updated `2026-09-10T03:56:14.789Z`.
- Job-bound artifact: `2027909139fa44f1db8b8106bc6fd73d17c5e8937369c8681516cab8afebdd8d`.
- Artifact location: formal worktree `data/web-runtime-artifacts/publication-2027909139fa44f1db8b8106bc6fd73d17c5e8937369c8681516cab8afebdd8d`.
- Artifact manifest job/version and all **10** stage hashes match PostgreSQL. Each stored stage payload also recomputes to its recorded content hash.
- Artifact build source fingerprint and the formal tree's current complete build-source fingerprint both equal `759113a75035dcbae756225823de982368525aa5c90a217918f7402e3103a37e` before and after preview. This binds the generated traffic source to this job's artifact; it is not an arbitrary global cache fallback.
- PostgreSQL reports transaction_read_only=`on`. No job, mirror, generated file, output or artifact was modified.

### Proposed changes (in-memory preview only)

| Stage | Proposed gap change | Ready count after preview | State |
| --- | --- | --- | --- |
| keywords | B0BHHP21DP and B0CZRBL776: SIF_KEYWORD_SCHEMA_INVALID -> UPSTREAM_EMPTY | 1/3 | partial |
| reviews | B0CZRBL776: MCP_SCHEMA -> UPSTREAM_EMPTY | 2/3 | partial |
| child_sales | B0CZRBL776: misleading product_reviews MCP_SCHEMA -> UPSTREAM_EMPTY; other two empty gaps retained | 0/3 | partial |
| category | B0CZRBL776: empty node consumer MCP_SCHEMA -> UPSTREAM_EMPTY | 2/3 | partial |
| traffic | Restore B09NNDX731's existing successful data and remove only its false empty gap; other two remain empty | 1/3 | partial |

The first four changes are conditional on the exact provider evidence documented in `2026-09-10-three-asin-sync-gaps.md`; this preview does not re-query those providers. The existing successful data payload for each of those four stages is hash-identical in the preview.

Traffic recovery uses the existing raw listing and monthly exports under the fingerprint-matched formal source, normalized by the real projectStageOutput code. B09NNDX731 is already module-ready in PostgreSQL. Its restored listing has normalized totalScore **26** (the source raw score was approximately 26.076; existing normalization rounds it), monthly data is present, and the listing digest is `3d24240f7d9eec58c511a06eef1f363bf6d525d5fb3b63b14db86ce107e2933a`.

### Reviewable candidate content hashes

These are preview payload hashes, not published replacements or job versions.

| Stage | Current v11 hash | Preview hash |
| --- | --- | --- |
| category | `3376031ce44228f5e293a072758e482defd75305847fd428db9e4af6825e56a2` | `21cbd8e52ac9dcf0568173e11cb7556590e001e80e65c1eb6e444de4b7a1cd36` |
| child_sales | `da7ea2d456afd962a4eff60b8925e22e44b8f90836402ee1a487b69d6dfce01c` | `5410de55f2aadb0f5adfbb4b724d3b9568bb62d8db0ecb319f19f68c15560ce8` |
| keywords | `d6ea5aa64d94bf09788c8b59961f1efcbbd204ef5b3eee1ac33f7af1f68d7875` | `de1515110958a3e9eb360db2c565d9cd02e110eff3bfcc00736dcf53759b375d` |
| reviews | `824a1e575def5c131d816f0b6046541fd8e461fbbfba160e9f1f235db65cc57c` | `7e72a565cffa7d06d62cd0435fc2122259f59030c5ed88763f345f2191320c00` |
| traffic | `ee18514e4f436378dad42f2fe0ad25d672639a43968164fa224c4cef158f3d1d` | `db5a8329b8b031d3ab84f8a553b47f31d730e1302a6e873b9474296dddb1e5d0` |

## Coordinator handoff and remaining limits

Any future scoped repair must independently fence the same job/version/current hashes, preserve successful siblings, reconcile the five affected module classifications and stage details, and use the project's existing versioned output/mirror publication discipline. This preview is not an application script or authorization to deploy. No job mutation, mirror repair, generated-data rewrite, artifact publication, service restart or push occurred.

FBA and price strategy remain genuine unavailable-value gaps; child-sales -1 remains unavailable, never zero sales. Restoring traffic and classifying empties does not make coverage 100%. Existing v11 data remains unchanged until the coordinator decides otherwise.

For the display workstream: this follow-up does not establish a new cause for missing review themes. It distinguishes confirmed missing upstream samples from failed transport/schema parsing and preserves historical diagnostics only as history. Do not infer no themes from a hidden or stale stage snapshot, or infer successful analysis solely from an old diagnostic's disappearance.
