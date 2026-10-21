# Collapsible sync gap details implementation plan

**Goal:** Apply the user's approved design: keep stage summaries visible, reveal ASIN-specific missing-data reasons only on demand, and remove the duplicated overview notices.

**Architecture:** Native closed-by-default details/summary controls live inside each existing sync stage row. Preserve source records, status summaries, and missing-value semantics. Unmatched diagnostic modules retain a collapsed fallback. The saved report's review page keeps its existing contextual notice.

**Tech Stack:** React, TypeScript, native HTML details, existing CSS and rendering tests.

## Constraints

- User approved the preceding design in chat; no further design approval is needed.
- Work only in the existing formal linked worktree after the current data publication finishes. Do not touch the main thread's candidate workspace or ports.
- No provider recollection or quota calls for this UI change. Read only the exact formal DE job ledger for usage.
- No new tests for this reversible presentation change; use applicable existing regression checks plus real browser collapse/expand validation.

## Steps

- [x] Add per-stage collapsed gap details, retaining a collapsed fallback for unmatched modules.
- [x] Remove the duplicate reviews, child-sales and FBA notices from the overview only; keep business-table unavailable values and other report surfaces intact.
- [x] Check types, relevant existing rendering tests and whitespace; inspect the scoped diff and commit.
- [x] Publish through the managed formal release path once idle; verify health and real expand/collapse behavior without restarting collection.
- [x] Report job-specific physical request counts separately from unknown supplier quota debit and unavailable cache-hit evidence.

## Verified result

- Code commit: `88a512d25212ea5e2cfe07f1349e3167753efb6f`.
- Typecheck and 14 existing focused regression checks passed. Existing source assertions were updated for the approved notice removal and the existing scoped-runtime fallback name.
- Managed production build and publish succeeded on 2026-10-21. Web 31900 PID 328564 and Agent 31901 PID 127172 report the same commit and source hash `da013482f91e889b2a2eb2d64815242798dc129d40dd8efa3be5bfd328158e3b`.
- Web artifact: `fb7ce0f8ec6d60b223a086f549faccf347820bd1e525fd4566dfcd1954371b8c`.
- Ports 32900/32901 and 33900/33901 retained their prior PIDs and source hashes.
- The live DE page showed three closed detail controls (reviews 3, child sales 5, FBA 2). All three expanded to show the original ASIN reasons and collapsed again. Duplicate overview lists were absent; unavailable table values remained explicit.
- Exact formal job `c207314a-2c2b-4882-9cab-baa44aecafdf`: SellerSprite 50, Sorftime 101, SIF 38 physical request attempts, total 189. Image 33 and translation model 1 are separate. Provider debit and cache-hit counts could not be established from available records.
- Evidence folder: `C:/Users/EDY/.codex/visualizations/2026/10/21/01a15d00-9eb3-7a20-9692-40fb46183339/formal-de-release/`. Includes `collapse-before.json`, `collapse-after.json`, `formal-DE-gaps-collapsed.jpg`, `mcp-usage.json`, and `mcp-usage-report.md`.
