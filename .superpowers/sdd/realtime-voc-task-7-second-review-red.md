# Realtime VOC Task 7 second-review RED evidence

- Base commit: `496796ad8793a1520f4d83049c7920a5953f73b8`.
- No live service, port `31900`/`31901`/`58258`, Chrome session, or external provider was used.

## Existing-manifest audit ordering and path safety

- Command: `npx tsx --conditions=react-server --test --test-name-pattern="binding replay does not|binding validates every" tests/agent/manual-alexa-voc-legacy-source.test.ts`.
- Exit code: `1`.
- Result: `2` tests discovered, `0` passed, `2` failed.
- Expected failures:
  - artifact drift was reported only after the missing audit had already been created;
  - a tampered owner manifest also created an audit before binding identity validation.
- The corrected tests additionally cover actor, marketplace, source-head identity,
  and a `../escaped-audit` identifier. The unsafe identifier must be rejected by
  the manifest schema and must not create a file beside the audit directory.
- A follow-up RED run of the identity test also proved that changing manifest
  records while leaving the old `sourceHeadsHash` could pass the binding
  comparison. It failed with `Missing expected rejection:
  invalid-artifact-heads` until the CLI checked the manifest's own canonical
  records hash before audit creation.

## PostgreSQL JSON-null and real upgrade boundary

- Command: `npx tsx --conditions=react-server --test --test-name-pattern="PostgreSQL 0020 replaces|actual 0019 schema" tests/agent/postgres-migrations.test.ts`.
- Exit code: `1`.
- Result: `2` tests discovered, `0` passed, `2` failed.
- Expected failures:
  - migration source had no explicit JSON string-type checks for
    `normalizedSchemaVersion` or `parserVersion`;
  - after applying the real schema only through 0019 and upgrading with the
    normal migration runner, a fully rehashed legacy provenance entry with a
    JSON-null `parserVersion` inserted successfully.

## Coverage-only characterizations

- The corrected SQLite test constructs an actual 0019 database, upgrades it to
  0020, accepts exact repository provenance, and rejects rewritten, missing,
  and JSON-null revision/parser/schema variants. It passed against the existing
  SQLite 0020 implementation, so this was a missing upgrade test rather than a
  missing SQLite constraint.
- The real PostgreSQL `RepositoryVocSourceReader` and `/v1/local-voc` tests
  passed once their fixtures met the existing three-ASIN request contract.
  They close the review's integration-coverage gap without requiring runtime
  reader or route changes.
