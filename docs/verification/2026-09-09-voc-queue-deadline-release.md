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

Implementation committed as `2e5a29de2d051b565de910ea6314ffb9cc6f187e`, containing only owned source/tests/docs. Unrelated source worktree edits and generated typecheck metadata remain unstaged.

Private operational backup: `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/voc-queue-deadline-20260909-2042`. Contains formal configuration, manager state, durable publication pointer, all 15 generated files with SHA-256 manifest, 72 files of the previous immutable Web artifact, and before/after metadata audit. Each copied file was hash-verified. No private configuration was committed.

At `2026-09-09T12:49:16.269Z`, a single direct call to the tested repository `expireVocQueue` used the explicit current run ID, 300000 ms timeout and batch limit 100. It expired exactly one never-started positioning attempt. Attempt/stage are now failed with `QUEUE_TIMEOUT`, retryable false, started null, lease generation 0. No service/worker was started for maintenance, and no Provider request was made.

The first operational probe expected the entire run to be failed and therefore reported an assertion failure after the committed expiry. Read-only verification showed the existing aggregate policy correctly returns **partial**, because `traffic-analysis` already succeeded. The probe assumption was corrected; no second expiry, rollback, manual status rewrite or business-code change was performed. UI observes the VOC stage, so it still displays the timeout failure while retaining other-stage success.

Read-only post-expiry checks: active aggregate 0; no remaining candidate passes the new claim predicate; cancelled historical attempts and all other attempt fields are unchanged; AgentRun/report/snapshot counts and digests match the recorded baseline. All due historical candidates were inspected, not only queued/running counts.

Formal branch fast-forwarded from `fff8c3e` to `2e5a29d`. All 15 generated-file hashes and configuration hash remain unchanged; index empty. The committed candidate-range diff check passes. A whole dirty-worktree diff check additionally reports pre-existing generated-file CRLF/trailing whitespace; those bytes were deliberately preserved.

After integration, the formal directory's six-suite queue/runtime/browser/normalization/job regression passed **84/84**, exit 0, 67.2 seconds. Activation is exclusively through `manage-formal-stack.ps1 -ProjectRoot <formal-root> -PublishCode`; final identity evidence is recorded below when complete.

## Released and verified

Controlled manager completed with exit 0. Durable commit time: `2026-09-09T12:54:25.106Z` (20:54:25 Asia/Shanghai).

- Formal HEAD / manager / Agent / Web source commit: `2e5a29de2d051b565de910ea6314ffb9cc6f187e`.
- Agent / Web source hash: `35465564ce4ef97ac44322f3be3f5fe1e2fb46e97d352aac5bf54a33522d3955`.
- Web / durable current / applied record artifact: `375091a47271e25c260e4daca823da4c7430c327f8bde487652aea7111f3920b`.
- Applied request: `c9f0b1bcbe3d80c05fabcff0a75f68402b0f821b695990b720c02fde7931bca8`.
- Base artifact and `dataCurrent` remain the previous `d8a62ee5...032a82f9`, with all ten stage content hashes unchanged.
- At `2026-09-09T12:56:19Z`, direct no-proxy checks returned HTTP 200 / status ok for local Web 31900, LAN Web 192.168.1.109:31900, and Agent 31901. The initial proxy-routed LAN probe returned 502; direct LAN access is healthy. No proxy or network configuration was changed.
- Manager ownership true; publication queues idle; active aggregate 0; port 3000 unused; PostgreSQL remains listening on 58258 (PID 51004), not restarted.
- Configuration and all 15 generated-file hashes unchanged. Previous artifact has a verified private copy.
- At `2026-09-09T12:56:28.797Z`, all inspected job metadata exactly matches post-expiry state, no remaining eligible historical claim, and all audit/report/snapshot preservation digests remain unchanged. No automatic model resubmission occurred during this observation window.

The evidence document is committed separately after activation; the running release intentionally remains pinned to the implementation commit above. No claim is made that unrelated pre-existing typecheck/lifecycle fixture failures were repaired, or that a real paid Provider analysis was executed for this release test.
