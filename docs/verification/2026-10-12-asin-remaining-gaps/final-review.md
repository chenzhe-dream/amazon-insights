# Final code re-review — retained daily cache correction

Verdict: **APPROVED for the reviewed candidate code. All three P2 review findings are closed; no further actionable code findings in this review scope.** The image test failure has been diagnosed without a production change; whole-candidate final validation remains pending the root's bounded-concurrency combined run.

## Scope

Reviewed the appended selector follow-up in whole-fix-report.md and current diff against `673eb9accff98d7b52657bce2f75e2bf34db8cd4`, focusing on scripts/build-sorftime-sales-trend.mjs and tests/scripts/sorftime-sales-repair-cli.test.mjs. The earlier seven-file trend fixes remain as reviewed in whole-rereview.md. No product, Git, provider, formal data or service changes were made. Only this requested review file was written. No suites or provider requests were rerun by this reviewer.

## Resolved final finding

- `scripts/build-sorftime-sales-trend.mjs:129-133` now decides daily field reuse from retained nonempty numeric day observations, independently of the latest response period. The ASIN/marketplace cache identity guard at line 128 remains in effect, as do date-shape, finite-value and nonnegative-value checks. Separate missing-only evidence does not qualify as numeric cache evidence.
- `observationPeriods` and `observationOutcomes` still describe the latest response, so an empty or unknown-month response is recorded truthfully without erasing prior usable daily evidence or inventing a day response.
- `tests/scripts/sorftime-sales-repair-cli.test.mjs:120` exercises both latest empty response and all-unknown monthly response via an actual persisted refresh, then invokes the actual missing-only repair CLI. It asserts zero SalesVolume dispatches, exactly SalesAmount/Price/Rank dispatches, unchanged retained daily value and original field/per-point collection dates, plus preservation of the missing-month timestamp.
- This closes the concrete reproduction from whole-rereview.md. The original blank/invalid-month verification and explicit missing-date preservation findings were already closed in that review and remain closed.

## Critical / Important / Minor

None in the reviewed candidate-code correction. No new image source diff was supplied for this pass; concurrent image-test edits and temporary fixtures visible in the shared checkout are outside this narrow approval.

## Validation and readiness limits

- Worker records test-first evidence: the new actual CLI regression failed before the selector fix, then the focused script suite passed **37/37**. Scoped lint, whitespace check and final TypeScript all report exit 0. These are reviewed report/test-source evidence, not independently rerun results.
- Root's latest final combined run reported **one failure out of 230** in the image concurrency test and is under separate diagnosis. This review does **not** declare that combined suite green or the overall candidate validation complete. Any image production-source fix needs its own scoped review before final acceptance; an isolated test-only correction still needs the relevant checks and final combined result recorded.
- No new supplier calls were made. Prior controlled live receipts and formal-boundary evidence remain as described in whole-review.md. Formal deployment, current-report switch and full formal browser acceptance remain separate, unchecked work.

## Assessment

The trend candidate code is ready for integration on the reviewed implementation. Overall candidate handoff readiness still requires resolution of the outstanding image concurrency validation result and completion of the root-owned final checks. This is code-review approval, not formal deployment or user-page acceptance.

## Image concurrency diagnosis follow-up

Reviewed task-1-concurrency-diagnosis.md and the small test-only diff in tests/scripts/image-remark-concurrent-candidate.test.mjs. The fixture now copies the collector with a closed diagnostic inserted into its existing final catch: only windows-lock-owner-identity-unavailable or other-integrity-error is printed. The original generic fatal outcome and nonzero exit remain, and no arbitrary error message, stack, credentials or provider payload are exposed. The replacement matches the current production main catch. The original internal Promise.all still launches both candidate jobs concurrently and validates separate job/URL-bound candidates afterward.

No production collector, interprocess-lock or candidate-validator source changed for this follow-up. Independently inspected the existing Windows process inspection path: PowerShell/CIM identity lookup is bounded to 2000 ms and unresolved current identity throws the exact reported error. The fail-closed lock prerequisite remains intact.

The diagnostic worker reports isolated tests **2/2** passing before and after instrumentation. Eight concurrent copies reproduced the two-job failure in every copy with the closed Windows lock-owner-identity-unavailable cause; their target-only tests passed. This identifies a prerequisite failure under process load and supplies no evidence of cross-job candidate mixing. It does not establish that high-load identity acquisition is reliable in all environments, so that limitation remains documented.

No further actionable code findings arise from this test-only change. Root is rerunning the same combined suite with outer file concurrency limited to two while retaining the tests' internal concurrency. Its final counts have not been supplied to this reviewer, so this report does not claim that run passed. Candidate code approval stands; final combined validation, subsequent source/build identity checks and formal/browser acceptance remain root-owned gates.

## Root final verification receipt

Recorded after the reviewer code verdict: the unchanged candidate source passed 231/231 combined affected tests across 25 files at --test-concurrency=2, plus 5/5 Xiyou static rendering tests. The internal Promise.all concurrent image jobs remain exercised. Direct tsc --noEmit --incremental false exited 0. Production build exited 0 with sourceHash 74ffaecf7a7a759ae0ca10d9bef1c41dc6633de07ec77a8dfdebbb1487d5a27b. Scoped lint exited 0 with one existing img warning; whitespace check exited 0. Candidate code committed as ad8dfa92ce8ca4a54b142cac9846f07f959a785c, following 673eb9accff98d7b52657bce2f75e2bf34db8cd4. No additional supplier calls or formal publication occurred. This closes the pending root verification noted above; formal current-report/browser acceptance stays unchecked.