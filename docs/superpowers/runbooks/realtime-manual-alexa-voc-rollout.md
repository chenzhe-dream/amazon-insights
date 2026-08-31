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
