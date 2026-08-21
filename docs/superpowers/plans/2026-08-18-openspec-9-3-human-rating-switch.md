# OpenSpec 9.3 Human Rating And Shadow Switch Plan

## Goal

Complete only OpenSpec task 9.3 by recording immutable six-dimension human ratings and module-mode changes in the existing `audit_events` table. The VOC module remains legacy-primary for ordinary users; agent output may be retained only as a shadow comparison and rollback to legacy must take effect on the next read.

Do not implement 9.4 release eligibility or an `agent-primary` mode. Do not add migrations, HTTP/admin endpoints, authentication, deployment, or page redesign.

## Constraints

- Base commit: `8eb5b08`.
- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-3-human-rating-switch`.
- TDD: add focused tests and capture expected RED before production changes.
- Reuse `audit_events`; do not modify migrations `0001` through `0008`.
- Ordinary VOC UI currently renders the deterministic legacy result only. Keep it unchanged rather than adding new config/API plumbing.
- Unknown, malformed, missing, or unreadable mode state fails closed to `legacy-primary`.
- Never expose an `agent-primary` value in the 9.3 contract.

## Task 1: Define the closed evaluation-control contract

Create a focused evaluation-control module containing:

- the exact six human-rating dimensions from the 9.1 baseline, each scored from 1 through 5;
- immutable rating and module-mode event types;
- only `legacy-primary` and `agent-shadow` modes;
- a fail-closed mode resolver that catches repository read failures;
- a pure result selector that always returns legacy as the public primary and retains agent output only as a shadow comparison.

Tests must reject missing/extra dimensions, invalid scores, and `agent-primary`, and must prove default, shadow, rollback, damaged state, and read-error behavior.

## Task 2: Persist append-only events in SQLite

Extend the SQLite repository with a narrow evaluation-control repository interface:

- append and list human ratings scoped by organization and VOC module;
- append module-mode changes;
- read the latest valid module-mode change;
- treat malformed latest mode metadata as unavailable so the resolver chooses legacy.

Use INSERT-only methods for the two event types. Tests must prove append history, organization isolation, latest-event ordering (including equal timestamps), strict reconstruction, and immediate rollback.

## Task 3: Verify and mark only 9.3

After focused GREEN, run the focused evaluation and repository tests, then the full agent suite, repository suite, normal test/build gate, Skill validation, strict OpenSpec validation, and `git diff --check`.

Only after every required gate passes, check only task 9.3 and commit with a new commit (never amend).
