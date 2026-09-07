# Code-only publication implementation report

Status: DONE. Branch `codex/feat-code-only-publication-20260907`; implementation base `011ca4602a9bd02533cb2babdaf73bd40c3f8876`. Commit subject: `feat: add guarded code-only Web publication`.

## Implemented

- Added a shared filesystem-free code identity validator, strict immutable manifest v3, reload request v5, and durable control v2. Legacy manifest v1/v2, request v3/v4 and business control v1 remain compatible.
- Code current contains only artifact/storage/code identity. Durable publication retains the latest actual business current in `dataCurrent`, preserves streams, and validates base at consumption and again at commit. Retention protects current, business provenance, stream references, reservations and queue references.
- Added operator prepare/submit/status helpers and CLI. Preparation reads actual Git HEAD and source fingerprint before/after the stable build, verifies the dist fingerprint, publishes through the existing artifact lock, and privately saves exact request identity under `.runtime/code-web-publications`. No request is enqueued during prepare. Submission verifies source, target, manifest, immutable fingerprint, base and active reservation before using the existing reservation-to-request handoff under consumer/artifact locks. Status requires an exact spool acknowledgement plus matching durable current/request/code identity.
- The default build still uses `runStableBuild` and `runBoundedProcess`; the existing spawn seam directs build logs to stderr so CLI stdout remains JSON. CLI failures use fixed bounded text and nonzero exit codes.
- Supervisor binds manifest/request code identity before spawning and uses the existing preflight, target health, durable commit and rollback path. Its executable entry computes actual startup source identity for Agent. Web children receive metadata from their actual immutable artifact; old metadata is removed when starting a business artifact.
- `-PublishCode` adds initial live guards, prepare, repeated live guards, owned restart, new Agent/source identity proof, submit, and bounded exact activation verification. Default restart behavior is unchanged. It cannot submit a prepared request before the new stack starts and exposes matching startup identity. CLI invocation explicitly runs from the supplied project root.
- Existing Agent/Web health routes expose optional bounded nonsecret source identity; the strict Agent health schema was updated coherently.
- Self-review caught the same-generation Alexa epoch retry path: it formerly repointed current to the old business artifact without replacing Web. The existing atomic control writer now retains code current/dataCurrent/request identity for this exact epoch-only retry while advancing the genuine stream epoch. Newer business publication still replaces code current normally.

## TDD evidence

1. Initial command: `node --test --test-reporter=spec tests/scripts/code-web-publication.test.mjs`. The lifecycle failed with `Error: Invalid Web artifact manifest` in `validateStageContentHashes` called by `publishImmutableWebArtifact`. This is the missing code contract: the publisher required business hashes. The initial negative-test run also exposed validation after artifact-lock acquisition, leaving that test's lock held; it was stopped, and the same lifecycle RED was captured cleanly with `--test-name-pattern='activation preserves'` (1 test, 0 pass, 1 fail). Validation now runs before acquiring the lock.
2. Operator RED: `node --test --test-reporter=spec --test-name-pattern='prepare reserves|operator rejects' tests/scripts/code-web-publication.test.mjs`: 0/2 passed, `operator prepare contract is required`, actual `undefined`, expected `function`.
3. Supervisor RED: `node --test --test-reporter=spec --test-name-pattern='code supervisor' tests/scripts/start-agent-stack.test.mjs`: successful activation returned `failed`, expected `applied`. Test setup option names were corrected before recording this contract failure; persistence remained real throughout.
4. Health RED: `node --import tsx --test --test-reporter=spec --test-name-pattern='bounded startup|running code artifact' tests/agent/health.test.ts tests/agent/web-health.test.ts`: 0/2 passed, expected source metadata was undefined.
5. Manager RED: `node --test --test-reporter=spec --test-name-pattern='code manager guarded' tests/scripts/manage-formal-stack.test.mjs`: default path passed; six code scenarios failed because actual events were only `stop,start`, missing prepare/submit/status. The additional old-supervisor regression initially observed `prepare,stop,start,submit,status`, expected only `prepare,stop,start`.
6. Reservation/CLI RED: `node --test --test-reporter=spec --test-name-pattern='expired reservations|CLI prepare' tests/scripts/code-web-publication.test.mjs`: missing expected expired-reservation rejection; stdout JSON parsing failed on `build log`.
7. Epoch retry RED: `node --test --test-reporter=spec --test-name-pattern='higher Alexa retry' tests/scripts/code-web-publication.test.mjs`: actual durable current became the older business artifact A, expected the activated code artifact B. GREEN after the narrow control fix: 1/1 passed.

## Final verification

- Combined suite: `node --test --test-reporter=spec tests/scripts/code-web-publication.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-publication-control.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs tests/scripts/manage-formal-stack.test.mjs` — **132/132 passed**, 0 failures/skips, 31.4 seconds.
- Health: `node --import tsx --test --test-reporter=spec tests/agent/health.test.ts tests/agent/web-health.test.ts` — **16/16 passed**, 0 failures/skips.
- After strengthening later-business activation to use actual artifact/request persistence and asserting failure seam child counts: `node --test --test-reporter=spec --test-name-pattern='code supervisor|later business' tests/scripts/start-agent-stack.test.mjs tests/scripts/code-web-publication.test.mjs` — **6/6 passed**.
- Changed-file ESLint: all 15 changed JavaScript/TypeScript source/test files passed, no warnings. The sole intermediate lint failure was the test variable name `module`, renamed to `publication`; the two subsequently strengthened test files passed lint again.
- `D:/Git/cmd/git.exe diff --check` passed. Git reports its existing LF-to-CRLF normalization warnings; test and lint output are otherwise clean.

## Files

New: `scripts/lib/code-publication-identity.mjs`, `scripts/lib/code-web-publication.mjs`, `scripts/publish-code-web.mjs`, `tests/scripts/code-web-publication.test.mjs`, this report.

Modified: `scripts/lib/web-artifact-store.mjs`, `scripts/lib/web-publication-control.mjs`, `scripts/lib/web-reload-request.mjs`, `scripts/start-agent-stack.mjs`, `scripts/manage-formal-stack.ps1`, `app/api/health/route.ts`, `server/app.ts`, `shared/agent-contracts.ts`, `tests/scripts/start-agent-stack.test.mjs`, `tests/scripts/manage-formal-stack.test.mjs`, `tests/agent/health.test.ts`, `tests/agent/web-health.test.ts`.

## Review notes and boundaries

- Reviewed for protocol downgrade, fabricated business metadata, false applied status, source drift, expired reservations, lost stream/provenance references and accidental runtime writes.
- Prepared records stay private and are not tracked. Abandoned reservations retain the existing 35-minute lease; normal handoff finalizes them. Existing quota/retention bounds still apply; expired records cannot authorize a new handoff.
- The artifact store and supervisor were already large modules; changes reuse their locks/writers/replacement lifecycle without restructuring them.
- Process spawning/HTTP and manager process/preflight seams are simulated in tests. Real artifact/control/request persistence is exercised. No real build, provider call, business POST, historical replay, formal service restart, database mutation, port stop, target integration, push or deployment was performed by this implementer. Fresh production build and real activation remain coordinator work after independent review.
- Root-owned plan/spec/ledger/deployment evidence and pre-existing untracked `test-results/` were not staged or changed.
