# ASIN sync gap recovery

Baseline: `65d2a154`; isolated branch `codex/sync-gap-recovery-20260929`.

Scope: investigate and fix recovery for the five ASINs in project A4竞对. No production mutation or release in this change. Preserve other windows' changes, authorization boundaries, provider accounting, and analysis rules.

1. Separate catalog availability from primary-provider completion. Retry Sorftime fallback catalogs when SellerSprite is available; keep usable fallback data available and honor explicit Sorftime-only plans.
2. Preserve previously verified category associations during scoped repair. Do not assign another ASIN's category, import evidence into a new batch as fresh, or erase unrelated cached products.
3. Replay retained SIF responses locally. Fix reproduced normalization defects and retain bounded failure context through the snapshot worker. Do not log credentials or raw responses.
4. Separate valid empty responses from consumer/schema failures for review and price collectors. Preserve verified zero-review semantics and never replace missing prices with zero.
5. Add failing regression tests before each fix, run targeted suites and TypeScript/lint checks, then document verified behavior and any historical data still requiring targeted resync.

Acceptance: incomplete catalog is eligible for retry; scoped category repair does not lose confirmed siblings; valid retained traffic reaches snapshot persistence or produces a precise safe error; malformed review/price responses cannot silently become upstream-empty.
