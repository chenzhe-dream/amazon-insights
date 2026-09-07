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

### Generated-data preservation evidence

The following byte-level hashes were captured before the fast-forward, then verified equal after merge, build, and the final preflight. These files remain unstaged modifications.

| File | Before SHA256 | After merge/build/final preflight |
| --- | --- | --- |
| `app/competitor-data.ts` | `397d5e990465f7219d5fd3b7f61c529b95a796de5e8e2cdd441be64b67012753` | unchanged |
| `app/listing-image-remarks.ts` | `58b78c6f88d99adf4464dda2c1cf4ccbc478350f7457805001f38a4b0de4774d` | unchanged |
| `app/sif-keyword-analysis-data.ts` | `1fa00b0f836d9be0a82c902bdad44ce3c08ed910661292bce80adda58a79ee1e` | unchanged |
| `app/sif-keyword-enrichment-data.ts` | `7a28255abe3f7bf4a0dd8f6028b37d78908e3056c081085554231448d22fa245` | unchanged |
| `app/sif-listing-traffic-raw-data.ts` | `100c69d7132b50cc569576168e1984b25744c3ec326c40d7edf4c022d7836cb7` | unchanged |
| `app/sif-monthly-traffic-trend-raw-data.ts` | `b4c92e2280a1fd7bda90990c3a698f1dcd6740f6fe41b4489d4f90875123bfab` | unchanged |
| `app/sorftime-category-trend-data.ts` | `8e6432a13a9decc8f94c3a3228266e99ef9d000fd2ca1d3079b7fbc68af46b47` | unchanged |
| `app/sorftime-child-sales-data.ts` | `411037b89df0322d9640ba3e82c3b4bffc27daca90dc337225f6eb0714d8766e` | unchanged |
| `app/sorftime-fba-fee-data.ts` | `33ab2b12d8779984aff22b7180f532b97cb674648c783c853a154c9bd519a27d` | unchanged |
| `app/sorftime-listing-content-data.ts` | `be70a42f8d2b0cd0cc58b6e5558b3bf3e9be2d337a02350788c299fc40c87c55` | unchanged |
| `app/sorftime-price-strategy-data.ts` | `aa1c4f80bc3418f656ee371c78f2bff42d85b44808a19b222189b6bd85705a61` | unchanged |
| `app/sorftime-rating-data.ts` | `c0d8ce31076023d1f7a19a9c29206a74c9362b36aeb2417fba73ffa9584aaecc` | unchanged |
| `app/sorftime-review-analysis-data.ts` | `4fb3a86116ff141b2748e20a586c99fddf165b047ed4c204ba9492dac8f080f5` | unchanged |
| `app/sorftime-sales-trend-data.ts` | `6557413554b2932243e80c33ee8fbf6984eed81022e69388e612bc18984d8bad` | unchanged |
| `app/sorftime-variant-data.ts` | `65b27302d3a6ed8f4ae87d4b8bc92c70cb2e7b92b837cf1e4f436e51f6ba2017` | unchanged |

### Regression ledger

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
