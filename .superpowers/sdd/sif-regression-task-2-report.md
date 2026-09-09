# SIF Regression Task 2 — corrected acceptance record

The initial implementation f53dcbf and its 30-test result were NOT the final acceptance gate. Review found incomplete row validation, unknown values treated as zero, self-labeled candidate scope and weak page wiring coverage. This supersedes the original report, including its incorrect no-new-TypeScript-debt claim.

Root corrections:
- Per-field merge preserves omitted accepted values but distinguishes missing, invalid, empty and zero. Unknown natural/ad scores remain null.
- Snapshot summaries do not read global detail. Production joins independently owner-accepted stage output, with project/run/job validation; no unproven cache hydration.
- Request-bound receipts plus owner tokens protect session/organization/logout/task changes, including A -> B -> A and late responses.
- Disposal has a specific owner-disposed tag; legitimate empty retry updates still apply. Tab return and terminal URL cleanup retain detail; only auth transitions rearm settled jobs.
- Insufficient natural/ad evidence is not graded as zero. No monthly algorithm/layout change.

Evidence:
- Worker substantive RED: 29/32 passed with three merge/state failures, then root corrections.
- Actual browser precision RED and missing-count RED preceded UI correction; source-regex wiring checks were replaced with mounted-page assertions.
- Conclusion RED reproduced unknown natural traffic being graded.
- Full regression exposed four terminal duplicate GET/completion failures; initialized auth-owner ref corrected them.
- Terminal tab-return RED timed out on lost detail; owner/disposal correction passed, with ABA and URL cleanup assertions.
- Historical summary provenance and counts 11/2/6 are confirmed; complete same-batch details are NOT. No historical replay/backfill.
- Fresh TypeScript comparison: baseline 339 diagnostics, current 334, no new fingerprint. Repository-wide type check is not clean.

Final commands/counts/build/deployment boundary live in docs/verification/2026-09-09-sif-traffic-regression-repair.md. Root owns checkout changes under the Sites skill; agents are read-only reviewers. Nullable views and UI corrections form one coupled local candidate. Formal service, provider, business database and caches are untouched.
