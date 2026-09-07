# VOC integration and formal-release preflight — 2026-09-07

Status: the approved VOC delivery has been integrated and freshly verified. Formal activation/restart is not complete: the existing launcher deliberately selects the previous durable immutable Web artifact, and there is no independent code-only publication entry.

## Scope and integration

- User approved integration into `codex/integrate-xydc-variant-20260905`, followed by a controlled formal update/restart after validation. This is not approval to update main, push GitHub, replay historical VOC inputs, or overwrite generated data.
- Integration worktree: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\integrate-xydc-variant-20260905`.
- Fast-forward completed from `d9d9d6e709c27f713303aad80381025d93ec63f8` to `14111dfd2e443a38de7a98d9c5fcaf2a995990af`: exactly 17 commits and 31 paths. The approved production code is the same as `45c1d7d2cff8b65936246da4bc0b7c61f8a20f86`; the delivery commit adds verification/progress documentation only.
- The 15 pre-existing modified generated TypeScript files do not overlap these 31 paths. Each file's SHA256 was captured before the merge and checked after merge and build; all 15 are unchanged. None was staged or committed. Existing untracked source `test-results/` and integration test outputs are preserved.
- Integration index remains empty. The scoped `git diff --check d9d9d6e 14111df` passed. An initial whole-working-tree whitespace check also inspected the pre-existing generated files and reported CRLF/trailing-whitespace warnings in `app/competitor-data.ts`; no unrelated formatting was changed. That failure did not undo the successful fast-forward and was not represented as a VOC regression.
- Local main remains `6caebaf0a3e5198f4d6c1962ca58e3b28e18d878`; cached origin/main remains `9690ab532c1f98a337e782a40686cf011adf6a10`. Neither was changed or pushed.

## Fresh tests in the integration worktree

All four runs below completed with zero failures, cancellations, skips, or todos. These are 214 scoped tests, not a claim that the entire repository is green.

| Run | Result | Duration |
| --- | --- | --- |
| Eight-file VOC recovery, normalization worker, PG/SQLite repository and worker-loop regression | 117/117 | 74335.2906 ms |
| Import validation, normalization status client, import feedback, client store, mounted import panel and PostgreSQL migrations | 86/86 | 52977.8903 ms |
| Tutorial/feedback browser tests against the fresh production build | 7/7 | 19707.8453 ms |
| Durable Web publication control tests | 4/4 | 1286.3997 ms |

Commands:

```text
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-multi-asin-recovery.test.ts tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/alexa-voc-normalization-attempts-contract.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-job-repository.test.ts tests/agent/worker-loop.test.ts
node --conditions=react-server --import tsx --test --test-reporter=spec tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-normalization-status-client.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/alexa-voc-import-panel-browser.test.ts tests/agent/postgres-migrations.test.ts
node --test --test-reporter=spec tests/agent/alexa-voc-tutorial-browser.test.mjs
node --test --test-reporter=spec tests/scripts/web-publication-control.test.mjs
npm run build
```

The build passed (exit 0). Fresh `createBuildSourceFingerprint()` equals `dist/build-fingerprint.json.sourceHash`:

`5505a4118ad6118c2fad921ca215893a6a6cfffd535b6df62e9e9fdd91646f9d`

The fingerprint includes the preserved generated data, so it legitimately differs from the clean repair worktree's fingerprint. No source build was copied over the integration build.

Tests used isolated databases/test-owned browser processes and audited fake providers. No user Chrome control, live provider call, or real business POST was performed. Expected SQLite experimental warnings, the previously disclosed PG concurrent-client-query warning, large build chunk warning and vinext route-classification limitations remain. The earlier whole-repository type/audit-contract debt was not repaired or re-certified here.

## Live preflight and confirmed blocker

Read-only preflight established no active sync jobs, stages, attempts, or analysis runs (`active=0`), verified manager ownership (`owned=true`), healthy Web 31900 and Agent 31901, one PostgreSQL 58258 listener, and no port 3000 listener.

- Canonical shared root: `C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime` (data and runtime remain external to the code worktree).
- Formal manifest commit remains `1eb1d4e9719a0a2f0951f687a61d6716e4cf86bc`, supervisor PID `70004`.
- Actual Web `/api/health` artifact and durable `current-known-good.json` both identify `248b941d2dcbcf0670697cf81f0586b89ce3cdda7b2a8b4be19c3ece5bd15349` (jobVersion 11).
- That immutable artifact's source fingerprint is `d2de1e10a666c3f06d835e5f457046426e8a0bbb13754d24b1a6b38db887feb7`, not the newly built source fingerprint above.

`scripts/start-agent-stack.mjs` starts Web using `artifactStore.current(expectedReloadTarget)`. `scripts/lib/web-artifact-store.mjs` prefers durable current over mutable `dist`. The existing control/immutable manifests require business publication provenance, and the Alexa publisher is tied to real Alexa generations. The restart/control tests confirm that rebuilding mutable dist alone must not replace known-good. This is a missing code-release path, not browser cache and not an active-task refusal.

OpenSpec confirmed there is no completed independent code-only design/tasks/implementation to reuse. Its older launcher and business-publication documents are references, not an approved completed code-release specification. A minimal independent code-release identity and activation path must be designed and verified; it must preserve existing business streams/provenance, use the existing lock/immutable store/supervisor health-and-rollback protocol, and not fabricate a job, generation or content hash. Merely deleting/overwriting the durable pointer or misusing bootstrap is not an acceptable release.

## Handoff state

No formal supervisor was stopped, no new artifact was activated, no live database migration was run, no old input was replayed, and no business data was cleared. In particular, do not replay wrong-target snapshot `9ec06711-35cd-42a4-a146-aef1764071cd` as a publication shortcut. The known-good service stays online; restarting it now would not prove the repair is live.

The integration target and approved VOC code are ready for the remaining code-only release-entry work. Keep that necessary increment distinct from the completed VOC repair, verify its activation/rollback behavior, and only then perform the user-approved managed restart with fresh live guards. Report actual Web artifact/fingerprint, Agent runtime identity, canonical roots and health rather than git HEAD alone.
