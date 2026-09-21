# Market overview first increment validation

Validated on 2026-09-12 against the integrated source checkout at commit `6445f1f98a0f65fcbba858d765013b3c0f3ee32c`.

## Automated checks

- `npm run test:market-research`: 40 passed. Covers collector scope and null/zero semantics, partial results, shared deadline, authenticated routes, independent navigation, result rendering, slow polling, session changes, UTC month boundaries, worker lifecycle, and organization-managed credentials without an AI execution identity. All vendor responses are isolated fixtures.
- `npm run test:market-research:postgres`: 8 passed, using a fresh local Docker PostgreSQL container and the actual migration chain. Covers organization isolation, idempotency, locked rows, lease recovery, stale-worker fencing, immutable reports, retry limits, revoked actors and the latest 30 history records. Test container cleaned up; formal database untouched.
- Targeted strict TypeScript and ESLint checks on the new collector/service/repository/contracts and page/browser helper passed.
- `openspec validate add-market-research-overview --strict`: passed.
- Independent review identified and verified fixes for slow-request polling starvation, missing organization credential resolution without an execution identity, and falsely successful malformed statistics responses.

## Existing project validation limits

Before and after integration, full `tsc --noEmit --incremental false` on the actual integration checkout reported 411 existing errors, including duplicate generated-data keys and unrelated runtime/test types. Comparison found no new diagnostic file/error-code pairs; the only message differences after ignoring line shifts were union-member ordering in two existing errors. A full-project passing build is not established by the targeted checks above. Existing generated data is outside this change.

## Integration verification

The 32 reviewed source/spec/test files were integrated into `integrate-xydc-variant-20260905`. Existing source originals were backed up outside the repository, and all 15 previously modified generated-data files retained their original SHA-256 hashes. `npm run test:market-research` was run again from the actual integration checkout: 40 passed. Migration 0033 was exercised only in the isolated PostgreSQL test container.

## Runtime acceptance still pending

The SellerSprite `tools/list` input schemas were checked without running a live category collection. Live result payloads, concentration units, visual browser acceptance and the complete market-overview distributions/trends remain pending. This increment contains basic overview metrics only; product shapes/price bands, keyword insight and category buyer comments are separate follow-up increments.

Source integration does not restart the running formal stack or apply migration 0033 to its database. When the user begins acceptance, use the existing local stack rollout workflow to load the new source and apply the additive migration before submitting a category job.
