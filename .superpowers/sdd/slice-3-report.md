# Slice 3 evidence — controlled Web reload

## Scope and safety

- Implemented only tasks 3.1–3.6. Task 3.7 remains unchecked for the independent review.
- No live listeners, sync jobs, connectors, deployment, push, or legacy team-server script were run.
- All behavior checks used fake children, fake health probes, or a temporary filesystem spool; no listener was opened by the test suite.

## RED evidence

- `node --test tests/scripts/sync-runtime-policy.test.mjs tests/scripts/web-reload-request.test.mjs` initially failed because `shouldBuildForSync` was not exported and `scripts/lib/web-reload-request.mjs` did not exist.
- `node --test tests/scripts/start-agent-stack.test.mjs` initially failed because `launcher.processReloadRequests` did not exist.
- The malformed-request archive test initially failed because untrusted request content was retained by the failure archive.

## GREEN evidence

`node --test tests/scripts/sync-runtime-policy.test.mjs tests/scripts/start-agent-stack.test.mjs tests/scripts/web-reload-request.test.mjs`

- 19 tests passed, 0 failed.
- Covered no runner Web spawn/restart, atomic/versioned safe spool payloads, target/worktree validation, safe malformed/stale/failed archival, idempotent duplicate no-op, candidate preflight before old-Web stop, final target health, rollback, unchanged Agent child, Windows-hidden child options, and no port-3000 launch arguments.

`rg -n "restartTeamServer|start-team-server\\.ps1" scripts/run-asin-sync-job.mjs tests/scripts`

- Returned no matches; the check completed as `PASS: no legacy restart references reachable from runner or script tests`.

## Build evidence

`npm run build`

- Exited 0 and completed all five build phases.
- The existing chunk-size advisory (>500 kB) was emitted; no build error occurred.
