# Task 1 report: preserve Xiyou variant evidence without credentials

## Scope

- Baseline: `a7633c3b2aef753edd609149f074ff20eac0119a`
- Branch: `codex/feat-xydc-parent-orders-12m-20260908`
- Owned files only: variant sync implementation, focused tests, formal environment example, and this report.
- No private configuration or credentials were read. No provider calls or new-ASIN analysis were run. Formal/runtime/shared files were not changed.

## Change

- The blank/whitespace-token branch now evaluates each requested ASIN independently.
- Cached evidence is reused only after schema validation and exact normalized country/input identity checks, with `ready` or `partial` status, nonempty children, and finite nonfuture `fetchedAt`.
- Eligible evidence is returned with `cacheState: stale` without rewriting its cache entry. Ineligible entries and cache misses retain the prior `NOT_CONFIGURED` write behavior.
- The nonempty-token path, public sync/cache interfaces, merge behavior, timestamps, cancellation, and provider coordination are unchanged.
- The tracked environment example now includes blank `XYDC_MCP_TOKEN`, an absolute placeholder coordination root, and a note that formal services read the protected external file.

## TDD evidence

RED before the production change:

`node --import tsx --test --test-name-pattern="missing.*token|without.*token|credential" tests/scripts/xydc-variant-sync.test.ts`

- Exit 1; 4 tests, 1 passed, 3 failed.
- Expected failures showed cached ready/partial family data replaced by fresh `NOT_CONFIGURED`, the mixed hit reported fresh instead of stale, and annual order display lost family identity.

GREEN after the minimal production change:

- Same focused command: exit 0; 4 tests, 4 passed, 0 failed.
- Tests cover blank/whitespace tokens, force false/true, ready/partial evidence, zero tool calls, no eligible-entry writes, mixed hit/miss persistence, invalid country/input/status/future/no-relationship rejection, and real temporary-file cache/order-display byte preservation.

## Verification

- `node --import tsx --test tests/scripts/xydc-variant-sync.test.ts`: 31/31 passed.
- `node --import tsx --test tests/scripts/xydc-order-display.test.ts`: 9/9 passed.
- `node --import tsx --test tests/scripts/xydc-order-sync.test.ts`: 15/15 passed.
- `npx eslint scripts/build-xydc-variant-data.ts tests/scripts/xydc-variant-sync.test.ts`: exit 0.
- `git diff --check`: exit 0 (Git emitted existing line-ending warnings only).

## Self-review

- The cache candidate is safe-parsed before access and cannot be promoted from malformed, mismatched, empty, unavailable, or future-dated evidence.
- Only misses/ineligible candidates enter the write list; eligible entries retain original stored bytes and timestamps.
- Unrelated pre-existing WIP under `.superpowers/sdd/progress.md`, `docs/verification/`, and `test-results/` was preserved and excluded from the commit.
