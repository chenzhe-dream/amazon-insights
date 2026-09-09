# VOC queue deadline repair and release verification

## Approved scope

User requested a timeout repair before releasing the already validated SIF repair. Default `AGENT_VOC_QUEUE_TIMEOUT_MS=300000` bounds VOC positioning queued/retry-wait time from `available_at`; an independent five-second sweeper persists `QUEUE_TIMEOUT`, stops automatic retry, and exposes a fixed Chinese message. Manual retry starts a new cycle. Existing Provider timeout is unchanged. This is not a five-minute deadline for every running VOC or normalization operation.

The claim path now excludes cancelled parents and superseded VOC positioning predecessors. Historical results, pending durable publication, reports, audit rows and snapshots are preserved. No external Provider call is required for verification or operational expiry. Database shutdown drains in-flight work; it is not bounded if the database itself never responds.

## Test-first fixes and review

- Reproduced the duplicate successor conflict against both storage implementations before repair.
- Added deadline boundary, delayed retry, manual retry, cancelled-parent, result preservation and PostgreSQL cancellation/retry/claim race tests.
- Independent review found restored-page identity/logout polling risks; fixed with abortable requests, session-scoped layout cleanup, and late-response browser tests.
- Recovery regression caught an overly broad latest-attempt rule: normalization must still recover an older pending publication when a new ASIN input arrives. Restricted the new predecessor rule to VOC positioning. Both previously failing normalization cases and the entire recovery matrix then passed.
- Final independent scope review approved specification and quality with no critical/important findings.

## Executed verification

- Final store/recovery run: `voc-queue-safety`, `alexa-voc-multi-asin-recovery`, `job-repository`, `postgres-job-repository`: **66/66 passed**, exit 0. This was rerun after the last predecessor-scope correction.
- Queue/runtime/UI/lifecycle/shutdown run: **129/129 passed**, exit 0. The final store-only correction is additionally covered by the 66-test run above.
- `npm run test:traffic-regression`: **36 script checks + 54 TypeScript/browser tests passed**, exit 0. Includes 1280/1920 display and restored VOC identity/logout/late-response tests.
- Related regression run originally returned 178/180: only the two normalization recovery cases described above failed, and both were corrected and rerun in the final full recovery matrix. Do not describe the original run as wholly green.
- Fresh final `npm run build`: exit 0. Existing large-chunk warnings remain.
- Targeted ESLint: exit 0; `git diff --check`: exit 0.
- Full typecheck still has 334 existing diagnostics, none attributed to the new/affected server files in the scoped comparison. This is not a clean whole-repository typecheck.
- Three `analysis-run-lifecycle.test.ts` route fixture failures reproduced unchanged on detached clean baseline `e1b0e83f8f7e1d55c72df9665e14db1998345631`: expected 200/201 vs actual 409/400 at lines 1129, 1307, 1468. Not modified by this repair.

## Pre-activation evidence

Formal source: `fff8c3ec097ab52c5a8f74eb278a2558ac6b7981`. Healthy Web artifact: `d8a62ee5ec5717e30f75c4b35f9c122c47844729b5397da4aa03b87b032a82f9`. Agent source hash: `f937306960dd0324cc6fbadf79ac8bf2717a52c5716d988ebe0cb266b89a454d`.

At `2026-09-09T12:32:55.655Z`, run `c39a954a-7dc1-49ba-be86-07387731814b` had one never-started queued VOC attempt, available since `2026-09-09T05:59:05.229Z`. Old run `78d7af51-37d4-4609-85c1-cd33cfd9b9b4` was already cancelled; its two failed historical attempts must remain unchanged. Aggregate preflight count 3 represents the current run, stage and attempt, not three separate tasks.

For these two runs, preservation baseline: AgentRun audit count 8, digest `7fad293aece9b632485e761489b65388`; report count 0; data snapshot count 12, digest `e0aceb01ef4ea94d9abebec701e1b9b7`. These are metadata hashes only; no private payloads or credentials are included.

## Activation status

Pending controlled activation. Only owned source/tests/docs may be committed. Preserve the formal worktree's 15 pre-existing generated files and source worktree's unrelated edits. Back up configuration, manager state and publication pointer before invoking the tested run-scoped expiry operation. Integrate by fast-forward, then activate exclusively through `manage-formal-stack.ps1 -PublishCode`. Record exact post-release identities and preservation checks below; do not infer publication from a build alone.
