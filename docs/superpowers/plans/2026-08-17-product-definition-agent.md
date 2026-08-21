# Product Definition Agent Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Complete OpenSpec 10.3 with an automatically scheduled, audited, versioned product-definition stage that consumes only a successful VOC report and an immutable keyword-analysis snapshot.

**Architecture:** Add an immutable keyword snapshot table through forward migration 0008. Both keyword snapshot insertion and VOC report publication call one transactional, idempotent dependency join that changes the existing product stage from `waiting-input` to `queued` and uses the existing JobAttempt/Worker path. A third runtime loads `define-amazon-product-from-voc-keywords@1.0.0`, validates a closed input/output contract, canonicalizes fixed commercial boundaries, and publishes through the existing immutable analysis report table.

**Tech Stack:** TypeScript, Zod, Node test runner, SQLite, existing SkillRunner/AuditedSkillRunner/JobAttemptWorkerLoop.

## Task 1: Dependency and keyword snapshot persistence

- [x] Add `tests/agent/product-definition-runtime.test.ts` RED cases proving missing dependencies stay `waiting-input`, list exact missing dependencies, never call the provider, and become queued automatically only after both persisted dependencies exist.
- [x] Add `server/data/keyword-analysis-snapshot.ts`, `server/db/keyword-analysis-snapshot-repository.ts`, and additive `server/db/migrations/0008_keyword_analysis_snapshot.sql`.
- [x] Extend `server/db/sqlite-repository.ts` with immutable keyword snapshot CRUD and one transaction-local product dependency join invoked from both dependency publication paths.
- [x] Run `npx tsx --conditions=react-server --test tests/agent/product-definition-runtime.test.ts` and expect dependency cases GREEN.

## Task 2: Product Skill execution and report publication

- [x] Extend the same test with fake-provider success, strict commercial-boundary rejection/canonicalization, report version identity, and SQLite close/reopen assertions.
- [x] Add `server/domain/product/product-definition-contracts.ts`, `server/services/product-definition-execution-service.ts`, `server/services/product-definition-worker-handler.ts`, and `server/runtime/product-definition-runtime.ts`.
- [x] Extend the analysis report repository/SQLite mapper for product reports while preserving VOC and traffic behavior.
- [x] Run the focused runtime test and related VOC/traffic report regressions; expect GREEN.

## Task 3: Composition and verification

- [x] Wire the product runtime into `server/agent-service.ts` start/stop and use the repository-backed keyword dependency provider in the HTTP lifecycle.
- [x] Add focused lifecycle wiring assertions without starting Web or using a real provider.
- [x] Run focused tests, relevant ESLint, `npx openspec validate build-standalone-agent-workflow --strict`, and scoped `git diff --check`.
- [x] Check only OpenSpec task 10.3, verify protected files are unstaged, and create one non-amend checkpoint commit.
