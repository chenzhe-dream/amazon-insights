# Minimal code-only formal publication

User confirmed the minimal code-publication direction on 2026-09-07. This implements that approved increment and the previously approved local integration/controlled restart, not a new deployment platform.

## Problem and outcome

The formal supervisor correctly prefers durable immutable current over mutable `dist`. A source merge/build/restart therefore still starts the old Web artifact. Introduce a code-only identity through the existing immutable publication and request/ack pipeline, without pretending a deployment is a business sync or Alexa generation.

## Contracts

- A code release is distinguished by `kind: "code"`, a SHA256 artifact ID, and `codeRelease: { sourceCommit, sourceHash, baseArtifactId }`. Commit is a 40-character lowercase Git SHA; sourceHash and baseArtifactId are 64-character lowercase SHA256 values. No business jobId, jobVersion, stageContentHashes, stream or generation is synthesized.
- Immutable code manifests use a separate version/strict shape, while existing v1/v2 artifact reads remain compatible. Reload code payloads use a separate strict version/shape with the existing exact target, build completion timestamp and request hash.
- Durable current admits the code variant. On code commit, retain the latest real business current as `dataCurrent`, preserve existing streams byte-for-byte semantically, and enforce baseArtifactId equals actual current before applying and at durable commit. A previous code current retains its existing dataCurrent. A later business publication continues normally and updates real business provenance.
- Persisted current is still written atomically only after final target health. Invalid/mixed identity, stale base, manifest mismatch, damaged state and health failure never become applied. Restart must select the newly committed immutable code artifact without reassigning business generation.

## Implementation boundaries

Reuse artifact/build locks, reservation-to-request handoff, existing spool/consume lock, supervisor candidate preflight, exact artifact health, final Web replacement and existing known-good rollback. Do not bypass current via bootstrap, delete its file, rewrite old immutable packages, or run a second permanent Web/supervisor. Existing business/Alexa payload readers and retention remain compatible. Retention protects current, retained dataCurrent and stream references.

Add an operator entry that prepares a fresh build while the old stack remains healthy, records actual source commit/fingerprint, and reserves an immutable code artifact. Preparation does not enqueue an unknown request to the old supervisor. The existing manager gains an explicit code-update option: all normal guards first, prepare, guards again, controlled owned restart to load new Agent/supervisor code, then submit the prepared code request for the new supervisor to consume. Ordinary restart without the option retains existing behavior. If candidate activation fails, keep/restore the prior healthy Web package and return failure, never report the release applied. If Agent/supervisor startup fails, retain durable known-good and fail closed under the manager's existing startup cleanup rather than report success or fabricate rollback of backend data.

The prepare/submit/status handoff is local operator-only, not an HTTP business API. Prepared records are private runtime state, not tracked source. Enforce a current built-source fingerprint before submission; do not publish a build while code changes. Recheck exact target and base. No dependency upgrades.

Runtime evidence must distinguish the actual Web artifact and codeRelease commit/hash, the running Agent source identity, and stack manifest/canonical roots. Pass non-secret startup identity to children and expose only bounded non-secret version metadata if needed. Do not emit connection strings, proxy tokens, credentials or raw business content.

## Verification and rollout

Isolated RED/GREEN tests must reproduce the old-current/new-build problem through real filesystem artifact/control/request state. Cover successful code activation and restart, exact metadata binding, unchanged business provenance/streams, stale base and mixed-field rejection, build failure before stop, failed preflight/final health retaining old current, reservation retention, and ordinary business publication after a code release. Test process/health seams may be fakes; do not mock persistence away. Keep existing publication and manager tests passing.

Run focused tests, changed-file lint, fresh source build and fingerprint match, independent task and whole-branch review, then integrate only this increment into `codex/integrate-xydc-variant-20260905`. Preserve its 15 generated dirty files byte-for-byte. Main and GitHub stay untouched. Perform the managed local update only after active=0, owned=true, fake=0, healthy 31900/31901/58258 and no 3000. Do not stop PostgreSQL, clear data, issue business POST/Provider calls, or replay historical VOC. Verify actual activated metadata, not merely HEAD or a generic 200.
