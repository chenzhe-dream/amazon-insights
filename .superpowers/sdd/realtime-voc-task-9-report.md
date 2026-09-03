# Realtime Manual Alexa VOC Task 9 Report

## Scope and baseline

- Task: approved plan Task 9, server-only best-effort Manual Alexa VOC
  publication outbox processing.
- Fixed starting commit:
  `a299564a9b68b963330eb6658cf3cf42b9475d21`.
- No `AGENTS.md` exists in the worktree or its parent repository.
- Read before implementation: the full approved final design, Task 9 plus its
  Task 2/6/7/8 dependencies, and the repository TDD/verification instructions.
- The exact Task 9 text is preserved in
  `.superpowers/sdd/realtime-voc-task-9-brief.md`.
- No live service, Web process, Chrome, external provider, old worktree, data
  rebuild, full build, or full lint was used.

## RED evidence

The complete RED record is in
`.superpowers/sdd/realtime-voc-task-9-red.md`.

1. Focused publication RED:

   ```powershell
   npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-publication.test.ts
   ```

   Exit `1`: `ERR_MODULE_NOT_FOUND` for the not-yet-created server projection
   store; `0` tests passed.

2. Agent Service lifecycle RED:

   ```powershell
   npx tsx --conditions=react-server --test tests/agent/agent-service-shutdown.test.ts
   ```

   Exit `1`: `2` passed and `1` failed because the enabled publication worker
   was not started and no immutable generation appeared.

## Minimal implementation

- Added a server-only projection store with HMAC owner partitions, strict US
  tenant scope, immutable monotonic decimal generations, atomic artifact and
  manifest replacement, revision/hash/captured-at provenance, and a
  tenant-scoped invalidation epoch/revision signal. Raw envelopes and crypto
  material are never projected.
- Added one outbox dispatcher/reconciler using the existing Task 2/5 repository
  lease API. It applies only after durable publication, keeps lease-generation
  fencing, retries with bounded exponential backoff, records safe error codes,
  and uses the existing same-content repair path for failed intent. A terminal
  attempt remains a failed row scheduled at the canonical far-future instant,
  because the approved outbox status contract has no separate dead-letter
  state.
- Crash replay is idempotent: re-publishing an equal revision compares the
  immutable content and does not create another generation or duplicate side
  effect.
- Added the exact nine metric names through an injected telemetry interface.
  Its type permits only `result`, `source`, and `status` labels.
- Defined the five independent exact feature flags, all false unless their
  value is exactly `1`. Publication configuration is validated only when the
  publication flag is enabled.
- Wired the publication runtime after isolated Agent Service listen, before any
  optional OpenAI runtime, and added it to the common stoppable runtime drain.
- Added the exact staged rollout and independent rollback runbook. Projection
  recovery is DB-head/outbox driven and never reverse-imports projection data.

## Fresh affected verification

### Focused GREEN

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-publication.test.ts tests/agent/agent-service-shutdown.test.ts
```

- Exit `0`; `7` passed, `0` failed; duration `2377.9172ms`.
- Covers tenant partitioning/cross-org invisibility, revision and invalidation
  epochs, crash replay, lease expiry, generation fencing, bounded retry,
  effective dead-letter, same-content repair, safe telemetry, disabled defaults,
  explicit configuration, runtime start, and shutdown drain.

### SQLite and PostgreSQL repository/outbox regression

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts
```

- Exit `0`; `35` passed, `0` failed; duration `25973.8461ms`.
- Both real database implementations passed lease, retry, apply, reconciliation,
  database-expiry fencing, monotonic lease generation, same-hash repair,
  transaction atomicity, tenant isolation, and run-claim coverage.

### Route and worker regression

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/sync-job-dispatcher.test.ts
```

- Manual VOC route and Web proxy route coverage passed completely (`13/13`).
- Dispatcher coverage passed `15/16`; the unrelated existing test
  `resumed canonical dispatcher closes the original traffic run and stage`
  failed in `server/db/postgres/sync-job-store.ts` with
  `Permanent category gap is not eligible for in-place resume`.
- Task 9 changes do not modify sync-job eligibility/store code. Per the strict
  convergence gate, this unrelated failure is recorded as deferred and was not
  debugged or changed. Task 9's publication worker lifecycle is independently
  GREEN in the focused `agent-service-shutdown` test above.

### Directed static checks

```powershell
npx eslint server/data/manual-alexa-voc-projection-store.ts server/services/manual-alexa-voc-publication-service.ts server/agent-service.ts server/config.ts tests/agent/manual-alexa-voc-publication.test.ts tests/agent/agent-service-shutdown.test.ts
```

- Exit `0`; no diagnostics.

A temporary `files`-only Task 9 TypeScript project extended the repository
configuration and selected the six changed TypeScript roots. Its affected-file
gate reported:

```text
Task9 directed TypeScript: 0 affected diagnostics (transitive baseline diagnostics: 69)
```

The transitive diagnostics are in unrelated existing generated/WIP app and
runtime sources. The temporary TypeScript project was removed after the check.

```powershell
rg -n "manual-alexa-voc-projection-store|manual-alexa-voc-publication-service|AGENT_MANUAL_ALEXA_VOC_PROJECTION" app public
git diff --check -- <exact Task 9 paths>
```

- Client/static projection scan: `0` matches.
- Exact Task 9 diff check: exit `0` (only Git's existing LF/CRLF notices).

Full build, full lint, and final client-bundle acceptance are intentionally
deferred to Task 12's unified release gate.

## Protected pre-existing WIP

The following pre-existing edits/artifacts were neither modified for Task 9 nor
staged: `.superpowers/sdd/task-3-report.md`, the existing `app/*-data.ts` and
`app/variant-data.ts` generated-data edits, `data/alexa-publication-snapshots/`,
`data/alexa-publication-state.json`, and the 17 pre-existing untracked
`data/projects/*.json` files. No broad `git add` command was used.
