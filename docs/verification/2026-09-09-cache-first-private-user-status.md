# Cache-first annual display and private user status — verification

Date: 2026-09-09. Status: implementation and task gates passed; final whole-change review pending. Not a production activation or real-account acceptance statement.

## Scope and baseline

- User approved the cache-first/private-presence design and self-reviewed, continuous in-scope execution. No inference of the personal DingTalk identity is allowed.
- Worktree: `fix-voc-import-status-20260907`, branch `codex/feat-xydc-parent-orders-12m-20260908`; whole-change baseline `b8b565ea50fb3d67b615418d60e731e743b8bbdc`.
- OpenSpec task confirmed no ownership conflict. Default parallel WIP and pre-existing import evidence/test-results are preserved.
- Task A source base: `3120e916638a33de0a96ca23812af4fdedc8e5a7`. Later coordinator plan-only commits are not feature implementation.
- Fresh baseline: 47 server/auth/cache tests and 20 UI tests passed, with no skips or cancellations. Existing UI Vite optimizer output was retained, not described as pristine.
- Full TypeScript baseline: 341 existing diagnostics. Exact `(file, code, message hash)` multiset is saved in ignored `test-results/cache-presence-ts-before-20260909.json`; completion requires no new fingerprints, not merely an unchanged count.

## Verification gates

- [x] Task A RED/GREEN, full targeted matrix and independent spec/quality review.
- [x] Task B RED/GREEN, real isolated SQLite/PostgreSQL binding tests and independent spec/quality review.
- [x] Root locked-source regression matrix and baseline-aware changed-file lint comparison. Final branch diff check remains part of the final gate.
- [x] Full TypeScript fingerprint comparison and isolated production build/source fingerprint match.
- [ ] Whole-change independent review; address any Critical or Important findings.
- [x] Scope-bound optimization review, with evidence and regression tests for any additional change.

## Identity and environment boundaries

- Trusted repository documentation designates primary email `admin@example.com`; email alone does not supply the required production organization/internal-user binding.
- Read-only code/history research found no explicit trusted identification of the user's personal DingTalk internal user, corporation and subject. A user-visible nonblocking request for the account row was sent. Until verified, the DingTalk grant must stay unconfigured and denied; no uniqueness/name/admin-role inference.
- PostgreSQL integration tests use the existing per-test loopback container helper, never the formal database. Its existing `postgres:16-alpine` image was confirmed present; no image pull was required by this check.
- Initial formal read-only check: health `ok`, formal HEAD `8f70e7df994f674177af0b3a54271b8458b37600`, Web artifact `337affd01ac62b2bd1c54ae850717de40c2225f23dbb8d1e9ef8d3efc0a02e49`, 39 shared data files including 3 prior authorized annual snapshots.
- Development does not invoke live Providers, mutate formal configuration/accounts/cache, restart services, deploy, merge main, push GitHub, or claim authenticated browser acceptance.

## Self-review decisions so far

- The two private-presence grants are independent. Email-role removal revokes the email grant, binding removal revokes the DingTalk grant, and inactive/cross-organization/session-invalid callers cannot use either. This clarifies existing intended behavior without promoting any account.
- The display implementation must reuse a browser-safe extraction of the existing collector freshness predicate instead of duplicating the 24-hour rule; collector API and TTL remain unchanged.
- During Task B, root reproduced a session-invalid boundary defect before accepting the implementation: the existing gate's 401 subscription cleared only React state; the new 403 handler could then copy the still-authenticated controller state back into the view before effect cleanup. Minimal callback-wiring RED exited 1 (`after403View=authenticated`, expected `unauthenticated`) in `.superpowers/sdd/private-presence-expiry-race-probe.ts`. The B plan and extracted brief now require authoritative controller/view invalidation and an actual boundary regression before approval; no production incident is claimed from this local reproduction.

## Task A locked-source verification

- Implementation commit `d19e67addd5e3db9473ba78d50f94a52b64e1a86`; detailed implementer RED/GREEN evidence in `.superpowers/sdd/cache-first-task-1-report.md`. Independent task review: Spec compliant / Approved, no Critical or Important findings; existing Vite fixture noise remains a nonblocking Minor.
- Root reran server/pure/writer/runtime matrix: **50/50**, 2323.2526 ms, no skips/cancellations. Coverage includes strict cache selection, unchanged freshness reuse, actual snapshot provenance, authorized ASIN filtering, and preservation on failed/partial forced refresh.
- Root reran UI/headless matrix: **35/35**, 19052.7807 ms, no skips/cancellations. Historical detail/annual inspection, current-window replacement, input switching, desktop/mobile bounds and existing progress owner passed.
- UI output included Vite optimizer scanning and one `Port 5173 is in use, trying another one...` notice. Both fixtures already requested port 0; installed Vite's `startServer` at `node_modules/vite/dist/node/chunks/node.js:26383-26384` maps that falsy configuration to its default port. This is bounded fixture startup noise, not an application test failure; no dependency or production behavior change was made. Use serial browser fixtures for the final combined run.
- Root full TypeScript comparison at this source: **341 → 341**, exact fingerprint multiset unchanged. The baseline helper reports diagnostics rather than a successful `tsc` compilation; pre-existing repository type errors remain.
- Root read-only real-cache replay `.superpowers/sdd/cache-presence-real-snapshot-probe.ts` passed for the previously collected three ASINs: 4/7/10 children and lower-bound totals 5900+/3750+/59450+. Explicit simulated clocks `2026-09-10` and `2026-10-10` exercise expiry and rollover; both retain actual source period `2025-09..2026-08` and original September 8 fetched timestamps. Four reads leave all three file hashes/mtimes unchanged. No collector or live Provider invocation; this is offline replay, not newly collected data or authenticated production acceptance.

## Task B and final source verification

- Task B implementation `ba5bb93f501858f5f75f6a90532e09ca999dd615`, follow-up `732dc84d6bb06f88f2988ebbd706ee0862198f3a`. Implementer stopped all source/fixture writes before final verification. Detailed RED/GREEN evidence is in `.superpowers/sdd/private-user-status-task-1-report.md`.
- Independent Task B review is Spec compliant / Approved, no Critical or Important issues. It verified policy, read-before-list authorization, both real database implementations, strict capability projection, current-request 403 clearing, and authoritative 401 expiry. Only confirmed baseline lint debt remains.
- Root locked B matrix: **101/101**, 9276.813 ms, no skipped/cancelled tests. Includes exact identity allow/deny and revocation, real isolated PostgreSQL/SQLite binding removal, unrelated admin-route denial, normal login/password changes, own activity heartbeat, and loader/session stale-response guards.
- Root mounted real `AuthSessionGate` regression: **1/1**, 3194.6176 ms. Command: `node --import tsx --test --test-name-pattern 'mounted auth gate keeps' tests/agent/primary-admin-browser.test.ts`. A mocked HTTP 401 passes through actual `localAgentFetch`, followed by the captured current-session revocation callback; the login page remains visible and protected content/user-status link disappear. This is isolated headless UI evidence, not a real DingTalk login.
- Root reran the unchanged A server matrix after B integration: **50/50**, 2279.0609 ms, no skipped/cancelled tests. Offline three-ASIN replay again retained the source window, totals, timestamps and exact file hashes/mtimes; Provider calls remained zero.
- Root serial combined annual/presence UI matrix: **41/41**, 22704.6245 ms, no skipped/cancelled tests. One Vite dependency-reoptimization notice remains; serial execution avoided the prior default-port fallback notice.
- Final TypeScript multiset comparison: **341 → 339**, **zero added fingerprints**. Only the old `primary-admin-browser-harness.tsx` TS2769 and `local-agent-browser.test.ts` TS2322 fixture diagnostics were removed. Intermediate new assertion/narrowing errors were fixed before source lock. This is not a clean whole-repository typecheck; 339 baseline diagnostics remain.
- Root ESLint inspected all 41 changed script/source/test files: no new findings. One existing `no-img-element` warning remains at `app/auth-session-gate.tsx:178`; four existing `react-hooks/immutability` errors remain in the reused primary-admin harness. Baseline/current lint were both executed; rule, diagnostic summary and the exact blamed statements match (old lines 95/103/105/106, now 132/140/142/143). Raw messages embed shifted codeframe line numbers and initially gave a false-positive comparison; the source-aware comparison resolved that without suppressing any diagnostic.
- Isolated `node scripts/run-stable-build.mjs` passed. The build reports a >500 kB chunk-size warning and vinext route-classification limitations; no dependency upgrade or warning suppression was attempted. These are optimization follow-up candidates, not proof of a user-visible regression. No formal build or service restart occurred.
- Post-build source and `dist/build-fingerprint.json` match exactly: `8aba3651c1673a13087bb59572123b4bc28be0d583b613258b8b314fbcd3e9f6`. An initial verification command incorrectly treated the fingerprint function's string return as an object; the corrected standalone assertion passed. This was a verification-command error, not a changed-source mismatch.
- `node --test tests/rendered-html.test.mjs`: **3/3**, 592.858 ms. Built SSR shows the checking shell without protected navigation. Read-only client-asset search found no `AGENT_USER_PRESENCE_` configuration names; no real identities or secrets were used in the build.

## Scoped optimization disposition and activation checklist

- Implemented and regression-tested: one shared cache freshness predicate, dependency-narrowed read-only identity lookup, authoritative controller/view expiry, and complete capability/session fixtures. No monthly hover/pie, periodic collection, global admin expansion or account merging was added.
- Deferred: pre-existing harness render-time global assignments and a measured bundle-splitting/performance study. They require separate focused changes and do not justify broadening this identity/cache patch or weakening test rules.
- Before formal activation, verify the exact internal user/organization for the designated primary email and the explicitly confirmed personal DingTalk account's current corp/subject binding. Set only the six server-owned keys documented in `.env.example` in private deployment configuration; never copy real values into Git, screenshots or frontend code. Partial/missing configuration authorizes no one on that branch.
- Configuration is snapshotted per process; changing these values requires a controlled service restart after the existing active-task safety check. Do not force through a running-analysis guard. Do not promote a DingTalk member merely to grant this one capability.
- After activation, verify both intended identities with real sessions, then another email administrator, another DingTalk user and an anonymous request. Verify both direct GET and UI denial, preserve normal heartbeat/analysis behavior, and record exact deployed source/artifact. Those real-account and deployment gates remain pending; isolated tests are not substitutes.
