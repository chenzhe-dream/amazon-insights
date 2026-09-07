# Code-only Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate a verified new code build through the existing formal supervisor while retaining business provenance and the prior known-good package on candidate failure.

**Architecture:** Add a strict code identity variant to existing artifact/control/request contracts, plus an operator-only prepare/submit/status entry. The manager explicitly prepares before its guarded restart and submits only after the new supervisor is healthy. Candidate activation and rollback reuse the existing Web replacement path.

**Tech Stack:** Node ESM, existing node:test/tsx/Playwright, PowerShell, existing PostgreSQL preflight. No new dependencies.

## Global Constraints

- A code release is distinguished by `kind: "code"`, a SHA256 artifact ID, and `codeRelease: { sourceCommit, sourceHash, baseArtifactId }`. Commit is a 40-character lowercase Git SHA; sourceHash and baseArtifactId are 64-character lowercase SHA256 values. No business jobId, jobVersion, stageContentHashes, stream or generation is synthesized.
- Preserve existing streams and the latest real business current as dataCurrent; enforce exact target and base identity before apply/commit. Existing legacy/business/Alexa contracts remain readable and retain their existing behavior.
- Reuse artifact/build locks, reservations, request/ack, supervisor preflight, exact artifact health and rollback. No new permanent supervisor/Web, no 3000, no deletion/bypass of known-good, no dependency upgrades.
- Work only in the isolated repair worktree/feature branch during implementation. No formal DB/config/data writes, restart, activation, real Provider/business POST, historical VOC replay, main update or push by implementers/reviewers. The root coordinator separately owns the already-authorized integration and guarded deployment after review.
- Preserve unrelated generated data and test-results; stage only named increment files. No reset/clean/stash/amend or worktree deletion.

## Task 1: Complete the code-release vertical slice

**Files:**
- Create: `scripts/lib/code-publication-identity.mjs` (small shared strict code identity validator, no filesystem or publication imports), `scripts/lib/code-web-publication.mjs` (local prepare/submit/status helpers), `scripts/publish-code-web.mjs` (operator CLI), `tests/scripts/code-web-publication.test.mjs` (real filesystem lifecycle regression).
- Modify: `scripts/lib/web-artifact-store.mjs`, `scripts/lib/web-publication-control.mjs`, `scripts/lib/web-reload-request.mjs` (code variants, preserved provenance, reservation/retention compatibility).
- Modify: `scripts/start-agent-stack.mjs`, `scripts/manage-formal-stack.ps1` (runtime identity and explicit code-update option).
- Test: existing `tests/scripts/web-artifact-store.test.mjs`, `web-publication-control.test.mjs`, `web-reload-request.test.mjs`, `start-agent-stack.test.mjs`, `manage-formal-stack.test.mjs` as appropriate.
- If runtime evidence cannot be read from existing health: narrowly modify `app/api/health/route.ts` and the existing Agent health route/response contract with optional bounded non-secret source identity, plus targeted tests. Locate the actual Agent route with `rg -n '"/health"' server` before editing; do not add a new auth or administrative endpoint.
- Report: `docs/verification/2026-09-07-code-only-publication-task-report.md`.

**Interfaces:**
- Existing `publishImmutableWebArtifact`, `createWebArtifactStore`, `writeWebReloadRequest[Sync]`, `consumeWebReloadRequest`, `readWebReloadPublication` accept strict code variants without weakening business variants. Use one shared code-identity validator; avoid duplicating validation and writer algorithms.
- Export `prepareCodeWebPublication({worktree, env, build})`, `submitCodeWebPublication({worktree, env, artifactId})`, `readCodeWebPublicationStatus({worktree, env, artifactId})` from the new module. `build` is an injectable callable defaulting to runStableBuild; actual HEAD and source/dist fingerprint are read and matched around the build. Preparation returns bounded JSON identity and stores its reservation privately; submit validates saved identity/current fingerprint/target before durable handoff; status reconciles exact stored request with durable current/ack, never a generic file's existence alone.
- CLI modes `prepare`, `submit <artifactId>`, `status <artifactId>` operate on cwd and formal environment; JSON result on stdout, bounded sanitized errors/nonzero exit on failure. Build logs must not corrupt machine-readable output.
- Manager explicit `-PublishCode` option calls prepare before Stop-OwnedStack, repeats active/owned/health gates after preparation, starts the new supervisor using actual source identity, submits, and waits boundedly for exact applied identity before reporting completion. Default manager behavior remains compatible. Never send code requests to a supervisor predating this contract.

- [ ] **Step 1: Write a natural failing lifecycle test and observe RED.** Seed a real business immutable current plus an Alexa stream, build a new directory through the normal artifact path, prepare and submit code release, and consume with real control/request persistence. The core expected assertions are:

```js
assert.equal(result.status, 'applied');
assert.equal(store.current(target).id, prepared.artifactId);
assert.deepEqual(control.streams, previous.streams);
assert.deepEqual(control.dataCurrent, previous.current);
assert.equal(control.current.kind, 'code');
assert.equal(control.current.codeRelease.sourceHash, built.sourceHash);
assert.equal('jobId' in control.current, false);
assert.equal(createWebArtifactStore({worktree}).current(target).id, prepared.artifactId);
```

Run `node --test --test-reporter=spec tests/scripts/code-web-publication.test.mjs`. Capture the expected missing-code-contract failure before implementation. Add separate negative cases with deepEqual previous persisted control after rejection, not mock-only assertions.

- [ ] **Step 2: Implement strict identity and durable lifecycle incrementally.** Code artifact manifest version 3 and code request version 5 distinguish the new shape; preserve old version validation unchanged. Add shared strict validator and use it at all boundaries. Durable control may use version 2 with dataCurrent, accepting old version 1 unchanged. The code commit selects dataCurrent from previous business current or previous code dataCurrent and never mutates streams. Validate baseArtifactId again under the existing consumer commit callback. Use the same atomic writer/lock/reservation primitives and update retention references. Tests must reject mixed code/business fields and malformed commit/hash/base.

```js
const codeRelease = validateCodeRelease(input.codeRelease);
if (previous.current.artifactId !== codeRelease.baseArtifactId) {
  throw new Error('Code publication base changed');
}
const dataCurrent = previous.current.kind === 'code' ? previous.dataCurrent : previous.current;
// Write the strict code current and retained dataCurrent using the existing atomic control writer.
```

- [ ] **Step 3: Integrate supervisor and operator handoff with failing tests first.** Compare code identity in candidate manifest/request before spawn; preserve the legacy content comparison for business requests. Supply actual startup/source identity and code Web metadata without secret output. Reuse replaceWeb, commitHighWater and rollback. Prepare uses real git/fingerprint checks and a reservation-backed private record; submit/status use exact saved target/request identity. Test existing durable old current plus fresh source, source drift, build failure, stale base, wrong target, mismatched artifact, failed preflight/final-health, durable commit failure and later business publication. For process behavior extend the existing fake-child seam instead of inventing mock persistence.

- [ ] **Step 4: Integrate the explicit PowerShell manager option.** Tests dot-source the manager and replace bounded process/HTTP/preflight seams only; no live ports are stopped. Assert that failed prepare does not call Stop-OwnedStack, post-build active>0/foreign ownership blocks stop, default restart stays unchanged, new code requests are submitted only after startup, failed activation is not logged as completed, and successful completion requires actual artifact/source identity. Avoid paths/secret output in error bodies. Keep all existing ownership, config, no-3000 and canonical-root checks.

```powershell
if ($PublishCode) {
  # Prepare before the existing owned-stop decision; re-run all live guards afterwards.
  $prepared = Invoke-CodePublication 'prepare'
}
# Existing verified owned restart, then submit prepared.artifactId only to the new supervisor.
```

- [ ] **Step 5: Verify and commit.** Run the combined new/existing publication/manager suites once, changed-file ESLint and git diff --check. Record actual RED/GREEN commands, counts and known warnings in the task report. Stage only the named source/tests/report; the coordinator owns this plan/spec/progress. Commit with `feat: add guarded code-only Web publication`. Self-review for protocol downgrade, lost provenance, false ack, reservation leakage and accidental runtime changes; report concerns rather than hiding them.

## Coordinator finish and deployment checklist

- [ ] Perform independent task review (spec and quality), fix blocking findings and re-review; then perform whole-branch review. No repeated user approval between these steps.
- [ ] Verify target HEAD/15 before hashes, integrate only the increment, rerun focused integration checks and production build. Confirm source/dist fingerprints match; do not overwrite generated data with the isolated source copy.
- [ ] Check formal guards and backup/preflight for the already-reviewed additive VOC migration as appropriate, then invoke the explicit manager code-update option. Never bypass active/ownership checks or stop PostgreSQL.
- [ ] Read actual applied Web artifact/source fingerprint, Agent source identity, manifest commit/canonical roots and 31900/31901/58258 health with no 3000. Verify generated hashes and no unexpected business work. Preserve known-good and report any failure honestly.
- [ ] Save deployment evidence, share exact increment/activation identities with OpenSpec for joint verification, and hand the user the test URL only once the new version is actually active.
