# SIF same-batch traffic detail recovery

> Execution: root owns implementation; read-only parallel research and independent review. User approved the bounded repair and recollection on 2026-09-10. Use TDD for each changed contract.

**Goal:** Restore the three selected ASINs' listing traffic details without restarting their analysis or touching VOC, favorites, generated files, or historical snapshots.

**Architecture:** Persist summary and all detail rows from the same two SIF responses per ASIN. Future traffic snapshots retain these normalized listing records. Historical runs receive a separate append-only collection with a new ID and actual collection time. The authorized snapshot read supplies the latest valid collection; the page treats it atomically and cannot overlay older stage-cache totals onto it.

**Tech stack:** Existing TypeScript, Zod, Fastify, PostgreSQL/SQLite, React and node:test. Existing LAN deployment only.

## Approved design and constraints

- Root cause verified: completed job 81f00bbf-0a3e-4e67-91e5-10cf32be908a stores only totals; immutable traffic snapshot for run c39a954a-7dc1-49ba-be86-07387731814b stores summaries, not detail rows. A new build cannot reconstruct omitted records.
- Target ASINs: B01E6CX34C, B07Y4PJJR4, B07WFC14VR, US. Provider calls for this recovery: overview + structure only. No monthly or model/VOC calls.
- Rejected alternatives: attach unverified global TS cache (unknown collection identity), overwrite historical snapshot (breaks audit), rerun whole project (unrelated work and does not prevent cache mixing).
- Use existing credential resolver and resource governor. No credentials or raw authentication responses in records/logs. Preserve missing vs returned-empty; malformed/partial responses fail closed.
- Recovery is an explicit scoped operation, bounded by an abortable deadline. Persist only after the complete batch validates; failure keeps last good collection, surfaces an actionable error, and permits explicit retry.
- Collection scope includes organization, project, run, marketplace, exact ASIN set. Read and write revalidate scope. Idempotent successful request IDs cannot overwrite a prior collection.
- Collection timestamp and checksum identify the new data; do not pretend it was captured in the old run. Historical monthly trend/reports are not recollected or rewritten.
- This is not a redesign. Existing traffic cards/rows remain; indicate actual source date and an explicit repair/retry control where needed.

## Execution checklist

- [ ] 1. Add failing normalizer/collector tests: complete details retained; malformed response, incorrect ASIN, missing channel arrays and abort reject; no generated files or monthly calls.
- [ ] 2. Implement shared strict listing collection schemas and normalization; add optional same-batch records to newly collected traffic snapshots.
- [ ] 3. Add scoped append-only collection repository and migration 0028 for the formal PostgreSQL store. SQLite keeps existing snapshot compatibility and returns explicit unsupported recovery. Test authorized append/read, idempotency, cross-org/run rejection, unchanged historical snapshots.
- [ ] 4. Add explicit recovery service and authenticated read integration. Test deadline/late-result behavior, last-good preservation, unknown run/foreign organization, and successful replay without extra Provider calls.
- [ ] 5. Add browser/display regressions proving collection summary+details win atomically over old stage totals. Preserve old monthly trend and other modules. Add readable failure/retry state.
- [ ] 6. Run scoped regression, independent review and production build. Resolve new regressions; distinguish known unrelated baseline failures.
- [ ] 7. Coordinate release; verify active work and backup exact formal generated/config files. Controlled formal manager only; never restart PostgreSQL or run full sync.
- [ ] 8. Recover only the approved run using a new collection identity. Verify persisted response checksums/counts, authenticated display, unchanged historical snapshot/stage/VOC/favorites and no generated-file mutation. Report genuine source gaps if returned.

## Verification commands

Run individual new tests with `node --import tsx --conditions=react-server --test tests/agent/traffic-listing-collection.test.ts`; then existing `sif-traffic-snapshot-task`, `traffic-snapshot-read-route`, `traffic-snapshot-browser`, `traffic-detail-view`, `traffic-display-regression`, `runtime-analysis-data` tests. Run `npm run build` after the final patch. Real-data acceptance must inspect the persisted collection, not merely synthetic browser fixtures or a successful process exit.

## Self-review

The design preserves immutable history, does not claim rounded totals prove provenance, keeps all scope dimensions explicit, and requires all-or-nothing listing publication. No shared global raw cache is used for recovery. New Provider calls are authorized by the user's approval; no other data source is included.
