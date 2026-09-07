# Code-only formal release verification

## Authorization and scope

The user confirmed the minimal independent code-publication entry and the controlled local formal-service update/restart. The only integration target is `codex/integrate-xydc-variant-20260905`. Main, GitHub, other branches/worktrees, existing generated data and test-results must remain untouched. No live Provider calls, business POSTs, old VOC replay or PostgreSQL restart are part of this release.

## Before activation

- Target code root: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\integrate-xydc-variant-20260905`.
- Target HEAD: `14111dfd2e443a38de7a98d9c5fcaf2a995990af`; index empty and the same 15 generated tracked files remain dirty. Their SHA256 values match the table in `2026-09-07-voc-integration-release-preflight.md` (freshly checked again during this release).
- Shared root: `C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime`; data/runtime roots remain external to the code worktree.
- Live manifest commit: `1eb1d4e9719a0a2f0951f687a61d6716e4cf86bc`; supervisor PID 70004.
- Actual Web health and durable current: `248b941d2dcbcf0670697cf81f0586b89ce3cdda7b2a8b4be19c3ece5bd15349`.
- Old immutable source fingerprint: `d2de1e10a666c3f06d835e5f457046426e8a0bbb13754d24b1a6b38db887feb7`.
- Read-only guards: active work 0; manager ownership verified; Web 31900 and Agent 31901 healthy; PostgreSQL 58258 listening; no 3000 listener; no pending/processing Web reload request.
- Database: 26 applied migration checksums match checked-in SQL. Migration 0027 is not yet applied. The legacy function contains the empty-array restriction that the reviewed migration replaces.
- Read-only counts: VOC revisions 21, VOC heads 21, snapshots 79, analysis runs 61, job attempts 79. A later explicit table-name check also recorded 73 Agent runs (distinct from the 61 analysis runs); the other counts remained equal.

## Backup

Before any live stop/migration, the coordinator created the private backup directory:

`C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\backups\pre-code-publication-20260907-142311-d6bf2e2e`

- `database.dump`: PostgreSQL custom archive, 4,105,808 bytes; SHA256 `4451DC298DDE2BB6A4B09FE3CDE39BD61489FC6DB30C2933BB138B7C27C891A9`.
- Complete `pg_restore --file=/dev/null` archive decoding passed. This is archive integrity validation, **not** a test restore.
- `stack-before.json` and `current-known-good-before.json` preserve the prior manager/control records.
- Credentials were passed only through process environment and were not printed. PostgreSQL and business data were not modified by backup/preflight.

## Verification and activation

Implementation commit: `97379405c8872cdba525b66210497b2ad7d0b0a5` (`011ca460` implementation base).

Fresh coordinator checks on that locked implementation:

- Six publication/manager script suites: 132/132 passed, no failures/cancellations/skips, 31,133.0917 ms.
- Agent/Web health: 16/16 passed, no failures/cancellations/skips, 1,178.568 ms.
- Tutorial/interaction browser regression against the fresh build: 7/7 passed, no failures/cancellations/skips, 15,272.4812 ms. Test-owned browser only; no user Chrome control.
- `npm run build`: exit 0. Existing large-client-chunk and vinext route-classification warnings remain; no new dependency/build changes.
- Source and dist fingerprint match: `aab4fe0b7bd32551c69e55efea5782164d7240a221f409c08efd26a9a55f5813`. This clean source fingerprint is not the eventual integration fingerprint, which must include the preserved generated data.
- All 15 changed JavaScript/TypeScript files pass ESLint with `--max-warnings 0`; branch-range `git diff --check bd7d783..HEAD` passes.

Independent Task review: spec compliant / Task quality Approved; no Critical/Important. Reviewer confirmed lease-based cross-CLI reservation lifetime, exact durable identity, unchanged legacy startup/rollback and epoch-only Alexa compatibility. Nonblocking coverage suggestion: add a dedicated successful prepare-CLI exit/prune/new-CLI-submit process test; actual lease logic and function-level persistence are covered.

Whole-branch review (`bd7d783..deab0aa`): Ready to merge **Yes**; no Critical/Important. The same process-test coverage suggestion remains Minor. The final reviewer additionally verified PowerShell stderr/stdout capture behavior with a read-only probe.

Fresh coordinator TypeScript check: whole repository remains non-green (exit 2, 341 diagnostics); **0 diagnostics in this increment's changed TS/TSX files**. This is not a whole-repository green claim.

## Target integration and final verification

- Fast-forwarded the approved target only: `14111df..deab0aae8f7d5a04fd7787a0292f4285fa7cabae`. Incoming changes had no overlap with the 15 dirty generated files; index was empty; all 15 hashes matched before and after merge and after activation.
- Fresh target publication/manager suites: **132/132**, 32,509.2546 ms. Fresh target health tests: **16/16**, 1,890.3759 ms.
- Target production build passed; source/dist fingerprint: `47d0235c16d15ac517e4173bc65ceb9de6782887a77f0f61b1b7fa59010f7628`.
- Initial target browser run was **6/7**: the first case timed out at `page.goto(..., waitUntil: "networkidle")` after 5 seconds, before its business assertions. The script suites were also running during that initial run. No code or timeout was changed. Isolated first-case replay passed **1/1** (7,756.3832 ms total), then a fresh serial whole-file replay passed **7/7** (15,958.2831 ms). This records an observed navigation-timeout flake; resource contention is a plausible inference, not a proven root cause.
- Branch-range diff check passed. The isolated-source and target scoped final results are each 155 tests, not 310 unique tests.

## Actual formal activation

The coordinator ran the unmodified guarded entry from the integration code root:

```powershell
& './scripts/manage-formal-stack.ps1' -ProjectRoot (Get-Location).Path -PublishCode
```

It completed with exit 0. Preparation built under the formal environment before stopping the old owned stack; existing live gates were checked again. Only then did the manager restart the owned supervisor/Agent, validate the new Agent source identity, submit the prepared code request and wait for exact applied/current/health agreement. Formal build output also noted configured proxy environment variables; no credential values were printed.

Post-activation identity was independently read from Web health, Agent health, immutable artifact fingerprint, durable control, exact request acknowledgement and current source:

| Evidence | Actual value |
| --- | --- |
| Running source / manager commit | `deab0aae8f7d5a04fd7787a0292f4285fa7cabae` |
| New Web artifact | `043a0f072ffa0fa74f4d8228bc6bfe579fd01e6d5228c9d94cd499cbdbacea6a` |
| Applied request | `bdb00981ab929f9e96dd6d5099cb273678f2defcba1a3c8f1b40ac36a14fa30e` |
| Source / dist / immutable fingerprint | `47d0235c16d15ac517e4173bc65ceb9de6782887a77f0f61b1b7fa59010f7628` |
| Retained prior base artifact | `248b941d2dcbcf0670697cf81f0586b89ce3cdda7b2a8b4be19c3ece5bd15349` |
| New supervisor PID | `22004` |

- Durable current is v2 with `kind: code`. Its `dataCurrent` deep-equals the backup's real business current; streams deep-equal the backup streams. No business provenance was fabricated or advanced.
- Code root, data root and runtime root remain the canonical paths above. Actual Agent `codeSource` matches the running commit and source fingerprint; Web `codeRelease` matches the exact durable current.
- Post-release guards: active 0, owned true, Web/Agent healthy, PostgreSQL listener 1, port 3000 listener 0, pending/processing reload requests 0.
- Normal Agent startup applied only the pending reviewed migration **0027**. All **27** applied checksums match source; the function no longer rejects empty VOC dimension arrays.
- Counts after activation are unchanged: VOC revisions 21, VOC heads 21, snapshots 79, analysis runs 61, Agent runs 73, job attempts 79. No historical input replay or real Provider/business POST was submitted.
- Backup archive size/hash remain equal. PostgreSQL was not stopped. The old package remains protected by real business provenance.
- Local `/` returned HTTP 200. The LAN address health endpoint returned the same new artifact. LAN reachability was checked from this host, not from a second physical computer.
- Local main remains `6caebaf0a3e5198f4d6c1962ca58e3b28e18d878`; cached origin/main remains `9690ab532c1f98a337e782a40686cf011adf6a10`. No push, main merge, worktree/branch deletion or unrelated data changes.

## OpenSpec handoff

Independent OpenSpec joint verification: **Approved**, no blocking findings, scoped to this code-only release's runtime identity, publication consistency and data protection.

The other task freshly and independently checked target HEAD/index/refs; both actual health responses; recalculated source/dist/immutable fingerprints; normalized the exact applied request and recomputed its request hash; verified v2 code control/v3 manifest with no business identity fields; compared retained real business current and streams with backup; checked all 15 generated file hashes; validated manifest roots/ownership and all required/forbidden ports; and queried migrations/counts under a read-only repeatable-read transaction followed by rollback. It confirmed all 27 migration checksums and removal of the old empty-array rejection while retaining the 256-item / 16,384-character bounds. Backup size/hash were independently equal.

The joint reviewer did not rerun suites, build, decode/restore the backup, deploy, invoke a Provider or run real business tasks. The initial browser timeout, global type-check debt, no-restore-test boundary and no-second-physical-LAN-client boundary remain explicit. The existing cross-CLI regression suggestion remains nonblocking.

The final evidence/progress update is documentation-only on the source branch. The integration target and actual formal service stay at verified `deab0aa`; no further restart or target mutation is required. Test-results remains local and untracked; the coordinator's compiler-generated cache was returned to its prior tracked bytes and was not included in the release.
