# Cache-first annual display and private user status — verification

Date: 2026-09-09. Status: implementation in progress; not a production acceptance statement.

## Scope and baseline

- User approved the cache-first/private-presence design and self-reviewed, continuous in-scope execution. No inference of the personal DingTalk identity is allowed.
- Worktree: `fix-voc-import-status-20260907`, branch `codex/feat-xydc-parent-orders-12m-20260908`; whole-change baseline `b8b565ea50fb3d67b615418d60e731e743b8bbdc`.
- OpenSpec task confirmed no ownership conflict. Default parallel WIP and pre-existing import evidence/test-results are preserved.
- Task A source base: `3120e916638a33de0a96ca23812af4fdedc8e5a7`. Later coordinator plan-only commits are not feature implementation.
- Fresh baseline: 47 server/auth/cache tests and 20 UI tests passed, with no skips or cancellations. Existing UI Vite optimizer output was retained, not described as pristine.
- Full TypeScript baseline: 341 existing diagnostics. Exact `(file, code, message hash)` multiset is saved in ignored `test-results/cache-presence-ts-before-20260909.json`; completion requires no new fingerprints, not merely an unchanged count.

## Verification gates

- [x] Task A RED/GREEN, full targeted matrix and independent spec/quality review.
- [ ] Task B RED/GREEN, real isolated SQLite/PostgreSQL binding tests and independent spec/quality review.
- [ ] Root locked-source regression matrix, changed-file lint and diff check.
- [ ] Full TypeScript fingerprint comparison and isolated production build/source fingerprint match.
- [ ] Whole-change independent review; address any Critical or Important findings.
- [ ] Scope-bound optimization review, with evidence and regression tests for any additional change.

## Identity and environment boundaries

- Trusted repository documentation designates primary email `admin@example.com`; email alone does not supply the required production organization/internal-user binding.
- Read-only code/history research found no explicit trusted identification of the user's personal DingTalk internal user, corporation and subject. A user-visible nonblocking request for the account row was sent. Until verified, the DingTalk grant must stay unconfigured and denied; no uniqueness/name/admin-role inference.
- PostgreSQL integration tests use the existing per-test loopback container helper, never the formal database. Its existing `postgres:16-alpine` image was confirmed present; no image pull was required by this check.
- Initial formal read-only check: health `ok`, formal HEAD `8f70e7df994f674177af0b3a54271b8458b37600`, Web artifact `337affd01ac62b2bd1c54ae850717de40c2225f23dbb8d1e9ef8d3efc0a02e49`, 39 shared data files including 3 prior authorized annual snapshots.
- Development does not invoke live Providers, mutate formal configuration/accounts/cache, restart services, deploy, merge main, push GitHub, or claim authenticated browser acceptance.

## Self-review decisions so far

- The two private-presence grants are independent. Email-role removal revokes the email grant, binding removal revokes the DingTalk grant, and inactive/cross-organization/session-invalid callers cannot use either. This clarifies existing intended behavior without promoting any account.
- The display implementation must reuse a browser-safe extraction of the existing collector freshness predicate instead of duplicating the 24-hour rule; collector API and TTL remain unchanged.

## Task A locked-source verification

- Implementation commit `d19e67addd5e3db9473ba78d50f94a52b64e1a86`; detailed implementer RED/GREEN evidence in `.superpowers/sdd/cache-first-task-1-report.md`. Independent task review: Spec compliant / Approved, no Critical or Important findings; existing Vite fixture noise remains a nonblocking Minor.
- Root reran server/pure/writer/runtime matrix: **50/50**, 2323.2526 ms, no skips/cancellations. Coverage includes strict cache selection, unchanged freshness reuse, actual snapshot provenance, authorized ASIN filtering, and preservation on failed/partial forced refresh.
- Root reran UI/headless matrix: **35/35**, 19052.7807 ms, no skips/cancellations. Historical detail/annual inspection, current-window replacement, input switching, desktop/mobile bounds and existing progress owner passed.
- UI output included Vite optimizer scanning and one `Port 5173 is in use, trying another one...` notice. Both fixtures already requested port 0; installed Vite's `startServer` at `node_modules/vite/dist/node/chunks/node.js:26383-26384` maps that falsy configuration to its default port. This is bounded fixture startup noise, not an application test failure; no dependency or production behavior change was made. Use serial browser fixtures for the final combined run.
- Root full TypeScript comparison at this source: **341 → 341**, exact fingerprint multiset unchanged. The baseline helper reports diagnostics rather than a successful `tsc` compilation; pre-existing repository type errors remain.
- Root read-only real-cache replay `.superpowers/sdd/cache-presence-real-snapshot-probe.ts` passed for the previously collected three ASINs: 4/7/10 children and lower-bound totals 5900+/3750+/59450+. Explicit simulated clocks `2026-09-10` and `2026-10-10` exercise expiry and rollover; both retain actual source period `2025-09..2026-08` and original September 8 fetched timestamps. Four reads leave all three file hashes/mtimes unchanged. No collector or live Provider invocation; this is offline replay, not newly collected data or authenticated production acceptance.
