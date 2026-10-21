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
- [ ] Publish through the managed formal release path once idle; verify health and real expand/collapse behavior without restarting collection.
- [ ] Report job-specific physical request counts separately from unknown supplier quota debit and unavailable cache-hit evidence.
