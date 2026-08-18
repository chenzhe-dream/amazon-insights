# OpenSpec 9.2 Automatic Evaluator Plan

## Goal

Complete only OpenSpec task 9.2 by evaluating a candidate VOC result against the versioned 9.1 cases and returning stable, localizable automatic gate results. Cover schema, deterministic values, evidence, data boundaries, fabricated data, safety downgrade, missing-input behavior, fallback behavior, and immutable report history.

Do not implement human rating persistence, feature switches, release eligibility, UI, or deployment work from 9.3/9.4.

## Constraints

- Base commit: `9307c22`.
- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-2-auto-evaluator`.
- TDD: add the evaluator test first and capture RED.
- Reuse the existing VOC semantic validator; do not duplicate deterministic or safety rules.
- Do not edit package locks, migrations, generated data, `.env*`, or other worktrees.
- No services, browser, provider, or network calls.

## Task 1: Make the production semantic validator reusable from a Skill input

Modify `server/domain/voc/voc-positioning-contracts.ts` with the smallest safe refactor:

- Keep `createVocPositioningOutputSchema(deterministicFacts)` behavior unchanged.
- Add a separately named export that accepts a parsed `VocPositioningInput`, adapts its snapshot/coverage/dimensions/evidence into the same internal read-only validation facts shape, and calls the exact same `validateOutput` implementation.
- Do not loosen either input schema or output schema.
- Add focused regression assertions proving the original facts entry and new Skill-input entry accept/reject the same valid, metric-forged, evidence-forged, boundary-broken, and safety-downgraded outputs.

The existing function cannot currently accept `VocPositioningInput` because it parses only `kind: voc-deterministic-preprocessing`; do not assume otherwise.

## Task 2: Add the automatic evaluator with RED-GREEN tests

Create:

- `server/evaluation/analysis-agent-auto-evaluator.ts`
- `tests/agent/analysis-agent-auto-evaluator.test.ts`

The evaluator must be a pure function. It receives a 9.1 case, a candidate output (or no output for the blocked case), and a closed execution observation:

- provider dispatched flag;
- terminal status (`succeeded`, `failed`, `waiting-input`);
- whether a previous/legacy result was selected as fallback;
- reports before and after, each with stable id, positive version, and content digest.

Return the eval-set version, case ID, overall pass/fail, and exactly these stable gates:

- `schema-valid`
- `deterministic-values-match`
- `evidence-resolves`
- `data-boundary-preserved`
- `no-fabricated-data`
- `safety-not-downgraded`
- `missing-input-marked`
- `failure-fallback-effective`
- `history-version-immutable`

Preserve closed VOC semantic rule IDs from Zod issue params; never expose arbitrary exception/provider text. Map the existing rule IDs to the relevant gate(s). A structural schema failure must fail safely without throwing.

Blocked `missing-voc-keyword` behavior is valid only when no candidate is accepted, no provider is dispatched, the terminal status is `waiting-input`, both missing dependencies remain declared, and fallback is effective.

History passes only if every prior id/version/digest is unchanged in the after list and any new report appends a unique version above the prior maximum. It must reject deletion, mutation, replacement, duplicate version, and non-increasing append.

TDD scenarios must include:

- valid scooter result passes all nine gates;
- missing/extra output fields fail schema;
- deterministic metric mutation fails deterministic/fabrication gates;
- dangling or cross-scoped evidence fails evidence/fabrication gates;
- coverage or decision-boundary mutation fails data-boundary gate;
- P0 downgrade or protected action omission fails safety gate;
- blocked case with an output/provider dispatch/wrong terminal/missing fallback fails closed;
- valid waiting-input blocked observation passes;
- prior report deletion/mutation/version replacement fails history;
- unchanged version 1 plus appended version 2 passes history;
- result contains only stable gate/rule IDs and no raw error text.

Focused command:

`npx tsx --conditions=react-server --test tests/agent/analysis-agent-auto-evaluator.test.ts tests/agent/voc-positioning-contracts.test.ts`

## Task 3: Verify and mark only 9.2

After focused GREEN:

- `npm run test:agent`
- `npm test`
- `npm run skills:validate`
- `npx openspec validate build-standalone-agent-workflow --strict`
- `git diff --check`

Only after every gate passes, check only task 9.2 and commit the plan, contract refactor/tests, evaluator/tests, and that single checkbox with message:

`feat(eval): add OpenSpec 9.2 automatic gates`
