# OpenSpec 9.1 Versioned Evaluation Fixtures Plan

## Goal

Complete only OpenSpec task 9.1 by adding a versioned, importable evaluation set with five sanitized cases: scooter complete, lighting complete, missing VOC/keyword input, third-party metric conflict, and non-downgradable safety P0.

Each case must contain a fixed deterministic input snapshot, deterministic expectations, forbidden conclusions, and a human-rating baseline. Do not implement the automated evaluator (9.2), rating persistence/feature switches (9.3), or release switching (9.4).

## Constraints

- Base commit: `9ee9d63076b2f3c8cac5b9db05880889d71e0e70`.
- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-1-eval-fixtures`.
- Do not edit `package-lock.json`, migrations, generated VOC/data files, `.env*`, or the original feature worktree.
- Do not start Web/Agent services and do not call external providers.
- Keep fixtures deterministic and sanitized; use synthetic ASINs where a real repository sample is not required.
- Checked-in TypeScript fixtures are preferred over hand-maintained JSON so existing schemas, builders, and canonical digests remain authoritative.

## Task 1: Add the RED contract test

Create `tests/agent/analysis-agent-eval-set.test.ts` first. It must fail because the evaluation-set module does not yet exist, then assert all of the following once implemented:

- evaluation-set version is fixed and all five required case IDs exist exactly once;
- every case includes a frozen/fixed input snapshot, deterministic expectations, non-empty forbidden conclusions, and the six human-rating baseline dimensions from the OpenSpec design;
- scooter and lighting complete cases have complete three-source coverage and valid closed VOC Skill input;
- missing VOC/keyword case records a deterministic non-executable/waiting-input dependency boundary without fabricating a valid Skill request;
- metric-conflict case preserves source-scoped 2/6/11 percentages and has no aggregate percentage;
- safety case contains a protected theme whose priority is P0, safety rule is non-null, and downgrade is forbidden;
- the exported set is deterministic across two builds/serializations and is deeply frozen.

Run only:

`npx tsx --conditions=react-server --test tests/agent/analysis-agent-eval-set.test.ts`

Capture the expected RED failure before implementation.

## Task 2: Implement the smallest importable fixture set

Create `server/evaluation/analysis-agent-eval-set.ts`.

- Define a closed Zod contract for the evaluation-set metadata and the two case forms needed here: executable Skill input and dependency-blocked input.
- Export one versioned evaluation set and a builder/loader that returns a deeply frozen value.
- Reuse production builders and schemas from:
  - `server/data/voc-data-snapshot.ts`
  - `server/domain/voc/preprocess-voc-snapshot.ts`
  - `server/domain/voc/voc-positioning-contracts.ts`
  - `server/domain/product/product-definition-contracts.ts` only where its public data boundary is needed.
- Do not import test helpers or implement pass/fail evaluation logic.
- Do not copy raw customer reviews or secrets. Synthetic source records must be sufficient to prove the expected behavior.
- Human baseline dimensions: accuracy, explanation quality, actionability, risk completeness, unsupported-inference avoidance, and business readability. Store baseline targets only; no rating workflow.

The five IDs must be:

- `scooter-complete`
- `lighting-complete`
- `missing-voc-keyword`
- `third-party-metric-conflict`
- `safety-p0`

## Task 3: Verify and mark only 9.1

Run the focused test until GREEN, then:

- `npm run test:agent`
- `npm test`
- `npm run skills:validate`
- `npx openspec validate build-standalone-agent-workflow --strict`
- `git diff --check`

Only after all gates pass, change task 9.1 from unchecked to checked in `openspec/changes/build-standalone-agent-workflow/tasks.md`. Do not change any other checkbox.

Commit only the plan, evaluation-set module, test, and the single 9.1 checkbox update with message:

`feat(eval): add versioned OpenSpec 9.1 fixtures`
