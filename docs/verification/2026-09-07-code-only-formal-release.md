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

Whole-branch review and guarded activation remain pending. This document does not yet claim the repaired version is live.
