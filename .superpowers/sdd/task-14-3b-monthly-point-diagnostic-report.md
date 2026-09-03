# Task 14.3b — monthly point diagnostic report

## Scope and boundary

- Baseline: `80bd74f906948ff5ac7d9d2cdfb42a701d7458d8`.
- Changed only the monthly diagnostic implementation, two agent tests, this OpenSpec evidence entry, and this report.
- The 15 generated `app/*.ts` WIP files and three untracked `data/projects/*.json` files remained unstaged and untouched.
- No live provider, browser, deployment, resume, retry, lifecycle, parser/normalization, hash, or database-schema operation was used or changed.

## RED

Added a test with an authorized raw `0`/`-0` before an invalid second point. Before implementation it failed as expected: the diagnostic selected `nfScore[0]` with `type` rather than the projected effective `nfScore[1]`, and had no point evidence.

Command:

```text
npx tsx --conditions=react-server --test tests/agent/sif-traffic-snapshot-task.test.ts --test-name-pattern "monthly point diagnostics select"
```

Observed failure: expected index `1` plus `{ type: "number" }`; actual index `0` with no `point`.

## GREEN

- `diagnoseMonthlyTrendShape(projectedCandidate, rawCandidate)` now derives monthly fields, length mismatch, and first invalid position from the projected candidate.
- It reads only the raw value at the already-selected score field/index and emits the bounded point union when permitted.
- The runtime validator accepts the legacy exact 3-key `firstInvalid` and the exact 4-key form, validates all point/field/index/reason and semantic correlations, and reconstructs every copied point scalar.
- Invalid or tampered point diagnostics are omitted as a whole while the fixed worker error remains.

## Test evidence

- `sif-traffic-snapshot-task.test.ts`: 21 passed, 0 failed.
- Focused Worker/PostgreSQL point persistence: 2 ASIN scenarios passed (one primitive point, one object point) using the actual monthly operation.
- Focused Worker/PostgreSQL tamper boundary: 14 malformed point scenarios passed; each omitted `shapeDiagnostic`, retained the fixed error envelope, and completed normally.
- Existing malformed diagnostic Worker boundary test passed.
- Changed-file ESLint completed with no findings.
- `npm run build` completed successfully (only existing chunk-size/classification warnings).
- `npx openspec validate stabilize-resumable-sync-pipeline --strict` reported the change valid.
- Scoped diff check completed with no findings for this task's changed paths.

## Commit evidence

Implementation and OpenSpec evidence commit: `93b97807684262569ba12692661bbdf168e1a7a5` (`feat: add bounded monthly point diagnostics`).

This report is committed separately because the evidence must record the immutable implementation commit hash.
