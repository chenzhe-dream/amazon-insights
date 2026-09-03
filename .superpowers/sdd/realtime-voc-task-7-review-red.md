# Realtime VOC Task 7 review-fix RED evidence

- Base commit: `b1b3728a9ba2363d72e3dcbbb1a9ebd2b3164144`
- Command: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
- Exit code: `1`
- Result: `38` tests discovered, `30` passed, `8` failed.

Expected failures proved each requested gap:

1. A valid manifest was still accepted with missing `LEGACY_VOC_DEFAULT_ORGANIZATION_ID`.
2. Changed static content was served with old owner/revision/capturedAt metadata instead of failing closed.
3. A failed audit write left a manifest without a stable audit identity for retry repair.
4. The real SQLite-backed reader did not expose/persist per-ASIN provenance.
5. The shared fixture still imported mutable `app/*` datasets.
6. PostgreSQL-backed dynamic records still used the static-file source reference.
7. Mixed dynamic/legacy selection did not retain record revision/hash/source/generation/capturedAt.
8. Snapshot integrity could not bind or reject tampered per-ASIN provenance because none was stored.

## Existing snapshot schema boundary RED

- Command: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/voc-positioning-contracts.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
- Exit code: `1`
- Result: `63` tests discovered, `62` passed, `1` failed.
- The only failure was the real SQLite reader persistence step:
  `invalid snapshot source provenance or snapshot sources exceed cutoff`.
- Cause: migration `0005_voc_data_snapshot.sql` requires exactly five source
  fields, hard-codes the static Alexa file reference, and recomputes its
  checksum without per-record provenance. Migration `0019_manual_alexa_voc.sql`
  does not change that snapshot trigger. No migration was added or renumbered
  in this Task 7 review fix.

## Audit repair ordering RED

- Command: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-legacy-source.test.ts`
- Exit code: `1`
- Result: `10` tests discovered, `9` passed, `1` failed.
- A committed manifest whose first audit write failed was still left without an
  audit when the static artifact drifted before retry. The retry must first
  repair the immutable audit described by the committed manifest, then report
  the later artifact conflict.

## Forward migration RED

- Command: `npx tsx --conditions=react-server --test --test-name-pattern="forward VOC provenance migration" tests/agent/sqlite-migrations.test.ts`
- Exit code: `1`
- Result: `1` test discovered, `0` passed, `1` failed because the paired
  `0020_voc_snapshot_per_asin_provenance.sql` migration did not exist.

- Follow-up command: `npx tsx --conditions=react-server --test --test-name-pattern="PostgreSQL 0020 accepts exact" tests/agent/postgres-migrations.test.ts`
- Exit code: `1`; the valid repository provenance inserted, but a fully
  rehashed nonexistent revision also inserted. This proved the migration must
  bind `source=repository` provenance to the organization-scoped immutable
  `manual_alexa_voc_revisions` row, not only validate JSON shape and hashes.

## Downstream repository-reference RED

- Command: `npx tsx --conditions=react-server --test --test-name-pattern="real SQLite reader" tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
- Exit code: `1`; the exact persisted snapshot reached deterministic
  preprocessing but failed with `VOC records are missing source provenance`
  because preprocessing still recognized only the legacy static-file Alexa
  reference.
- After recognizing the new reference, the same focused test remained RED
  because Alexa evidence used the aggregate source capture time for every ASIN
  instead of each selected record's exact provenance `capturedAt`.
