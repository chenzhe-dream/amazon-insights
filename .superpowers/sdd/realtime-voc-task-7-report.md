# Realtime Manual Alexa VOC — Task 7 report

## Scope and baseline

- Task: Convert `RepositoryVocSourceReader` to dynamic DB-first reads and owner-gated legacy.
- Fixed starting HEAD: `ee066f2ff6e1be69c366bd35286cd2aae1b4f2d1`.
- Branch/worktree: `codex/stabilize-resumable-sync-pipeline` in the assigned isolated worktree.
- No live service, port `31900`/`31901`/`58258`, Chrome session, or external provider was touched.
- Existing generated-data and report WIP was preserved and excluded from staging.

## RED

- Command: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts`
- Exit: `1`.
- Result: `12` tests, `3` passed, `9` failed.
- Expected causes: the server-only legacy module did not exist, and the old synchronous reader treated the new injected repository dependencies as static Alexa module data.
- Detailed evidence: `.superpowers/sdd/realtime-voc-task-7-red.md`.
- A separate pre-change baseline run of the old `voc-data-source` suite had `3` failures because it read the user's uncommitted generated `app/rufus-voc-data.ts`; this was not caused by Task 7.

## GREEN and verification

1. Plan regression:
   - Command: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/voc-data-snapshot-service.test.ts tests/agent/data-snapshot-repository.test.ts tests/agent/postgres-data-snapshot-repository.test.ts tests/agent/voc-deterministic-preprocessing.test.ts`
   - Exit: `0`.
   - Result: `64` passed, `0` failed; PostgreSQL tests executed successfully.
2. Additional affected-boundary regression:
   - Command: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/formal-voc-submission.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
   - Exit: `0`.
   - Result: `33` passed, `0` failed.
3. Targeted lint:
   - Command: `npx eslint` over all Task 7 source and test files.
   - Exit: `0`; no diagnostics.
4. Full repository typecheck:
   - Command: `npx tsc --noEmit --pretty false`.
   - Exit: `1` from pre-existing unrelated repository/WIP diagnostics (including generated `app/*`, sync/runtime contracts, Cloudflare globals, and unrelated tests).
   - A fresh filtered pass found `TASK7_RELEVANT_LINES=0`; no diagnostic named any Task 7 source, caller, helper, or test file.
5. `git diff --check` over Task 7 files passed.

## Implementation

- Runtime Manual Alexa VOC now queries the injected organization-scoped repository at the exact cutoff first.
- Repository connection, timeout, permission, schema, and deserialize errors propagate and never consult legacy data.
- Successful per-ASIN misses alone invoke the server-only owner gate.
- Dynamic results validate organization, marketplace, requested ASIN, unique identity, decimal revision, SHA-256 shape, parser/schema versions, canonical normalized record (including `alexaReport`), and exact canonical UTC `capturedAt`.
- Legacy loading is deferred until owner/market/schema/generation eligibility succeeds; no client module imports the new loader.
- Legacy results use owner-manifest per-ASIN revision/generation/capturedAt, expose only the safe API-shaped record, and mark date-only pre-binding values as `legacy-static-date-only` while normalizing them to end-of-day UTC.
- The one-time CLI refuses request-derived organization arguments, requires a fixed valid `LEGACY_VOC_DEFAULT_ORGANIZATION_ID` and an active actor in that organization, writes the manifest with exclusive atomic file creation, rejects different rebinding, and writes an immutable audit event.
- Production callers and test fixtures now supply organization context and await the async reader; static review fixtures remain compatible.

## Files

- `.superpowers/sdd/realtime-voc-task-7-brief.md`
- `.superpowers/sdd/realtime-voc-task-7-red.md`
- `.superpowers/sdd/realtime-voc-task-7-report.md`
- `server/data/legacy-manual-alexa-voc-source.ts`
- `server/cli/bind-legacy-manual-alexa-voc.ts`
- `server/data/repository-voc-source.ts`
- `server/routes/local-voc.ts`
- `server/services/voc-data-snapshot-service.ts`
- `tests/agent/voc-data-source.test.ts`
- `tests/agent/manual-alexa-voc-legacy-source.test.ts`
- `tests/agent/voc-data-snapshot-service.test.ts`
- `tests/agent/data-snapshot-repository.test.ts`
- `tests/agent/postgres-data-snapshot-repository.test.ts`
- `tests/agent/voc-deterministic-preprocessing.test.ts`
- `tests/agent/helpers/voc-positioning-fixture.ts`
- `tests/agent/sqlite-migrations.test.ts` (an additional existing reader caller required by the async signature)

## Risks and follow-on boundaries

- Repository-wide typecheck is still red from unrelated existing worktree changes; Task 7 files are clean under targeted TypeScript filtering, lint, and executable regression tests.
- Existing Web client imports of `app/rufus-voc-data.ts` predate this task and are assigned to the later client-bundle removal task; Task 7 adds no client-side legacy import or dataset copy.
- Task 8 still owns atomic run cutoff/revision selection/snapshot creation in one database transaction.
- Later publication work still owns generated per-owner server-only projections; this task supplies the read gate and the one-time binding path.

## Commit

- Subject: `feat: read manual voc dynamically with gated legacy`.
- Scope: one independent Task 7 commit containing only the files listed above.
- Exact commit object ID is reported immediately after commit creation because a commit cannot embed its own hash in its tracked report.

## Changes-requested follow-up (new commit on `b1b3728`)

### Review RED

- Initial review command: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts`.
- Result: exit `1`; `38` tests, `30` passed, `8` failed. The failures covered every review gap: owner config drift, static artifact drift, non-repairable audit, missing per-ASIN provenance, mutable fixture imports, misleading static reference, mixed-source provenance loss, and provenance tampering.
- Audit-order RED: `10` tests, `9` passed, `1` failed because artifact drift before retry prevented repair of the already-committed binding audit.
- Migration RED: the focused SQLite migration test failed because paired migration `0020_voc_snapshot_per_asin_provenance.sql` did not exist.
- PostgreSQL cross-check RED: a fully rehashed nonexistent revision inserted successfully, proving JSON/hash self-consistency alone was insufficient.
- Downstream preprocessing RED: the neutral repository source reference was initially treated as unavailable, then per-ASIN evidence time was incorrectly forced to the aggregate source capture time instead of the selected record's provenance time.
- Detailed evidence: `.superpowers/sdd/realtime-voc-task-7-review-red.md`.

### Review GREEN and verification

1. Task 7 source/service/repository regression:
   - Command: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/voc-data-snapshot-service.test.ts tests/agent/data-snapshot-repository.test.ts tests/agent/postgres-data-snapshot-repository.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
   - Exit `0`; `85` passed, `0` failed.
2. SQLite repository/migration regression:
   - Command: `npx tsx --conditions=react-server --test tests/agent/repository.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
   - Exit `0`; `55` passed, `0` failed.
3. Full PostgreSQL migration regression:
   - Command: `npx tsx --conditions=react-server --test tests/agent/postgres-migrations.test.ts`
   - Exit `0`; `25` passed, `0` failed. This includes fresh/reentrant migration, 0018→0019 upgrade parity, concurrent runners, checksum behavior, exact repository provenance acceptance, and rejection of a rehashed nonexistent revision.
4. Exact per-ASIN downstream regression:
   - Command: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/voc-positioning-contracts.test.ts`.
   - Exit `0`; `51` passed, `0` failed. The real SQLite reader snapshot preprocesses the neutral repository reference and binds Alexa evidence/denominators to each ASIN's exact provenance `capturedAt`.
5. Targeted lint:
   - `npx eslint` over all changed Task 7 TypeScript source/test files exited `0` with no diagnostics.
6. TypeScript:
   - `npx tsc --noEmit --incremental false --pretty false` remains exit `2` from the pre-existing unrelated worktree errors in generated `app/*`, sync/runtime contracts, Cloudflare globals, and unrelated tests.
   - A fresh filtered run reported zero diagnostics in every changed Task 7 source/test file.
7. `git diff --check` is run over the exact staged Task 7 file list before commit.

### Review implementation

- The legacy owner manifest now commits the binding actor/audit identity, artifact generation, per-ASIN content hashes/capture identities, and a canonical source-heads hash. Loading static content verifies the complete dialog ASIN set and every committed identity before returning any record.
- `LEGACY_VOC_DEFAULT_ORGANIZATION_ID` is required and must still match the manifest owner even when a manifest exists; missing, wildcard, whitespace-drifted, or changed configuration fails closed before static data is loaded.
- Binding audit creation is idempotently repairable. A retry repairs the immutable audit described by the committed manifest before checking/reporting later artifact drift.
- Repository reads retain ordered per-ASIN `revision`, `contentHash`, `source`, nullable legacy `generation`, exact canonical UTC `capturedAt`, normalized schema, and parser version. The Alexa source reference is now `repository://manual-alexa-voc/selected-revisions`, never the old static-file reference for runtime DB-first selections.
- Source checksums and the snapshot content hash bind this provenance. Candidate integrity rejects ASIN-order drift, noncanonical timestamps, inconsistent source/generation combinations, capture mismatch, or provenance tampering.
- Deterministic VOC preprocessing recognizes the neutral repository source reference and carries each selected Alexa record's exact provenance capture time into availability denominators, evidence facts, and record keys; the aggregate source capture time remains only the maximum upper bound.
- Paired forward migration `0020_voc_snapshot_per_asin_provenance.sql` replaces only the 0005 insert validator/trigger in SQLite and PostgreSQL; migrations 0005 and 0019 remain unchanged. Old static snapshots remain readable/valid, while new repository provenance is strict.
- Both databases verify repository provenance against the exact immutable `manual_alexa_voc_revisions` row under the snapshot run/project organization, including revision, content hash, capture time, schema/parser version, and normalized JSON.
- The shared VOC positioning fixture is checked-in immutable data and imports no mutable `app/rufus-voc-data.ts`, Sorftime, or SellerSprite dataset. A real SQLite repository/reader integration proves DB-first selection, no-row fallback, cross-organization isolation, owner-gated legacy loading, mixed provenance, and persistence.
- The two unimplemented follow-on plans were renumbered only for migration allocation: Comparison owns 0021 and Keyword Evidence owns 0022.

### Review files

- `.superpowers/sdd/realtime-voc-task-7-review-red.md`
- `.superpowers/sdd/realtime-voc-task-7-report.md`
- `server/data/legacy-manual-alexa-voc-source.ts`
- `server/cli/bind-legacy-manual-alexa-voc.ts`
- `server/data/repository-voc-source.ts`
- `server/data/voc-data-snapshot.ts`
- `server/domain/voc/preprocess-voc-snapshot.ts`
- `server/db/migrations/0020_voc_snapshot_per_asin_provenance.sql`
- `server/db/migrations/postgres/0020_voc_snapshot_per_asin_provenance.sql`
- `tests/agent/voc-data-source.test.ts`
- `tests/agent/manual-alexa-voc-legacy-source.test.ts`
- `tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
- `tests/agent/helpers/voc-positioning-fixture.ts`
- `tests/agent/sqlite-migrations.test.ts`
- `tests/agent/postgres-migrations.test.ts`
- `tests/agent/repository.test.ts`
- `docs/superpowers/plans/2026-08-31-comparison-draft-asin-management.md`
- `docs/superpowers/plans/2026-08-31-sif-keyword-evidence-fallback.md`

### Review risks and commit

- Full repository typecheck remains red only outside this Task 7 change; all scoped tests, migrations, lint, and filtered TypeScript are green.
- Static fallback stays server-only and is available only to the explicitly configured immutable owner; no tenant record or fixture data was added to a client import path.
- No live service, port `31900`/`31901`/`58258`, Chrome session, or external provider was touched.
- Follow-up subject: `fix: bind manual VOC snapshots to exact provenance`.
- Exact follow-up commit ID is reported after commit creation.
