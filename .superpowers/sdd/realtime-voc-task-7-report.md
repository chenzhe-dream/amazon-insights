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
