# Realtime Manual Alexa VOC Rollout and Rollback

## Safe defaults and prerequisites

Every Manual Alexa VOC flag is independent and defaults to `0`:

- `AGENT_MANUAL_ALEXA_VOC_WRITE_ENABLED`
- `AGENT_MANUAL_ALEXA_VOC_DYNAMIC_READ_ENABLED`
- `AGENT_MANUAL_ALEXA_VOC_LEGACY_FALLBACK_ENABLED`
- `AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED`
- `MANUAL_ALEXA_VOC_UI_ENABLED`

Before changing a flag, apply the forward-only SQLite and PostgreSQL migration
`0019_manual_alexa_voc.sql`, verify the repository schema, and configure an
active `MANUAL_VOC_RAW_REPORT_KEYRING`. A missing active key must make imports
fail with `503 VOC_PERSISTENCE_UNAVAILABLE`; it must never select a plaintext
or static-file write path.

Publication additionally requires:

- `AGENT_MANUAL_ALEXA_VOC_PROJECTION_ROOT`: an absolute operator-owned server
  directory outside the repository, `app`, `public`, `dist`, `.next`, and every
  Web build context.
- `AGENT_MANUAL_ALEXA_VOC_PROJECTION_PATH_KEY`: a server secret of at least 32
  characters used only to derive opaque owner partitions.
- A stable, unique `AGENT_MANUAL_ALEXA_VOC_PUBLICATION_OWNER_ID` per worker.

Lease, polling, reconciliation, retry, and maximum-attempt settings have safe
defaults and may be overridden with the corresponding
`AGENT_MANUAL_ALEXA_VOC_PUBLICATION_*` variables. Keep the poll interval below
the lease duration, the reconcile interval at or above polling, and the initial
backoff at or below the maximum backoff.

## Rollout order

1. Apply migration `0019_manual_alexa_voc.sql` and configure the raw-report
   keyring. Keep all five flags disabled.
2. Enable `AGENT_MANUAL_ALEXA_VOC_WRITE_ENABLED=1`. Confirm each accepted import
   commits its immutable revision, head, audit row, and outbox intent in one
   transaction.
3. Configure the external projection root/key and enable
   `AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED=1`. Verify outbox drain,
   projection lag, retry, and dead-letter metrics without reading projection
   files back into the database.
4. After the release gate confirms that all tenant Manual VOC client imports
   are removed, enable `MANUAL_ALEXA_VOC_UI_ENABLED=1`.
5. Enable `AGENT_MANUAL_ALEXA_VOC_DYNAMIC_READ_ENABLED=1` for server snapshots
   and new run snapshots. Observe cut-off and stale-epoch behavior for one full
   release.
6. Only if the owner gate is configured and stale fallback is explicitly
   accepted, enable `AGENT_MANUAL_ALEXA_VOC_LEGACY_FALLBACK_ENABLED=1`.

Observe these exact metric names. Labels are limited to `result`, `source`, and
`status`; organization identifiers, report text, crypto material, filesystem
paths, and manifest fields are forbidden:

- `manual_alexa_voc_write_total`
- `manual_alexa_voc_read_total`
- `manual_alexa_voc_overlay_lag_ms`
- `manual_alexa_voc_cutoff_excluded_total`
- `manual_alexa_voc_publication_total`
- `manual_alexa_voc_publication_lag_seconds`
- `manual_alexa_voc_outbox_total`
- `manual_alexa_voc_stale_epoch_response_dropped_total`
- `manual_alexa_voc_legacy_gate_total`

## Rollback decision tree

- UI or overlay regression: set `MANUAL_ALEXA_VOC_UI_ENABLED=0`. Preserve every
  database revision, head, audit row, and outbox intent.
- Dynamic snapshot/run regression: set
  `AGENT_MANUAL_ALEXA_VOC_DYNAMIC_READ_ENABLED=0`. Do not substitute static data
  after a database, schema, permission, timeout, or deserialization failure.
- Projection worker regression: set
  `AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED=0`. The authoritative database
  remains readable and pending/failed intents remain repairable.
- Authoritative write outage: set `AGENT_MANUAL_ALEXA_VOC_WRITE_ENABLED=0` if a
  controlled freeze is required. Database write failures return `503`; never
  report success from a client/static-file fallback.
- Legacy fallback regression: set
  `AGENT_MANUAL_ALEXA_VOC_LEGACY_FALLBACK_ENABLED=0`. Legacy remains disabled by
  default and never bypasses the server owner gate.

Never delete or roll back historical revisions to recover a release. If a
projection is corrupt or absent, disable publication, quarantine the external
projection directory, and rebuild only from authoritative database heads and
revisions through the outbox. Never import a projection or manifest back over a
database head.

## Task 12 final acceptance record (2026-08-31)

The acceptance run used only the fixed
`stabilize-resumable-sync-pipeline` worktree at baseline
`b159c06ce5b1bb503da4f644bfebb86c1c977cdd`. It used in-process HTTP services,
temporary SQLite databases, and local PostgreSQL test containers. No real
provider, production service, Chrome session, protected tenant source, or
repository/static-file write path was used.

### Focused rollback and isolation gates

- `tests/agent/manual-alexa-voc-rollback.test.ts`: RED 1/6 before the five
  flag/response boundaries were wired; GREEN 6/6 afterward.
- Focused contracts/service/routes/client/publication/atomicity matrix: 68/68
  passing in 7.335 seconds.
- Previously deferred dispatcher: RED 15/16 on canonical traffic in-place
  resume; GREEN 16/16 in 61.254 seconds after restoring the strict canonical
  lifecycle while retaining category-only fail-closed checks.
- PostgreSQL sync-job repository: 24/24 passing in 37.030 seconds, including
  terminal and stranded-exhausted resume, snapshot/non-unique rejection, and
  transactional reset rollback.
- A stale production output was intentionally checked first: both bundle
  sentinels failed (0/2) because legacy tenant inputs were present. After a
  fresh production build, client and Web SSR isolation sentinels pass 2/2 and
  never print the dynamically selected protected values.
- Changed-file ESLint: exit 0 with no diagnostics. Strict OpenSpec validation
  and scoped `git diff --check` also pass.

### Final unified gates

- `npm run build` followed by
  `node --test tests/manual-alexa-voc-client-bundle.test.mjs`: exit 0; build
  completes and sentinel tests pass 2/2 in 115.795 milliseconds. The existing
  minified-chunk advisory is non-blocking.
- PostgreSQL migrations, PostgreSQL Manual VOC store, and SQLite/PostgreSQL
  run-atomicity suite: 52/52 passing in 44.738 seconds.
- `npx tsc --noEmit --incremental false`: compiler exit 2 with 306 existing
  diagnostics; filtering to every Task 12 changed path yields 0 diagnostics.
  The incremental flag is disabled so this evidence does not modify the
  tracked build-info cache.
- `npm run lint`: exit 1 with 8,058 existing repository problems (213 errors,
  7,845 warnings) in unrelated app, generated runtime artifact, and browser
  harness paths. Explicit Task 12 changed-file lint remains clean, so this is
  recorded as a deferred baseline gate rather than expanded into this change.
- `npm run test:agent`: safely interrupted with exit 1 after 14.05 minutes.
  TAP output stopped after the early AgentRun repository tests; the active
  child was the unrelated `tests/agent/agent-run-service.test.ts`, with 204.03
  CPU seconds and more than 13 minutes without a new TAP line. Focused Task 12,
  dispatcher, PostgreSQL repository, migrations, Manual VOC store, and atomic
  run gates all completed independently and passed as recorded above.

### Acceptance and rollback result

The Task 12 contract is accepted: write/repository failures fail closed,
dynamic read failure never becomes static fallback, owner-gated legacy data is
explicitly stale, publication disablement preserves committed revisions, UI
and tenant epochs clear/reject client overlay state, and each run remains fixed
to its creation snapshot. The two full-repository baseline failures above are
deferred and must not be treated as permission to enable any flag. Roll out in
the documented order, one default-off flag at a time, and use the rollback
decision tree without deleting historical revisions.
