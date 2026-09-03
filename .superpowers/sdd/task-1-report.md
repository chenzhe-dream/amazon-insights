# Task 1 Report: Isolate scoped diagnostic-mirror replacement failures

## Scope

Implemented only Task 1 from `docs/superpowers/plans/2026-09-02-sync-publication-data-quality.md`:

- `scripts/lib/sync-job-store.mjs`
- `server/services/sync-job-worker-handler.ts`
- `tests/agent/sync-job-mirror-atomic-replace.test.ts`
- `tests/agent/sync-job-worker-handler-lifecycle.test.ts`

No GET route, Provider call, service restart, deployment, business POST, generated runtime file, or lock-identity implementation was changed.

## RED evidence

The Temp worktree cannot establish Windows process identity. Running the focused mirror test without a test-only identity shim failed all seven cases before the test body with:

```text
Error: Unable to establish Windows interprocess lock owner identity
```

The same environmental baseline occurred in the lifecycle suite: seven existing tests and the two new tests failed in `#writeInitialMirror` before their intended assertions.

To exercise the mirror behavior without modifying lock production code, a test-only `NODE_OPTIONS --import` shim was placed outside the repository at `C:/Users/EDY/AppData/Local/Temp/codex-test-lock-identity-injector.mjs`. It only supplies deterministic CIM output to the interprocess-lock test process.

Before production edits, the scoped mirror fixture was run with a target containing `scope.organizationId` and injected six `EPERM` rename failures:

```text
{"ok":false,"attempts":6,"waits":[10,20,40,80,160],"code":"EPERM","lockRecovered":null}
{"jobId":"job-scoped-persistent","scope":{"organizationId":"organization-1","projectId":"project-1","runId":"run-1"},"message":"before"}
```

The two new lifecycle tests were then run under that test-only shim before production edits. They failed for the intended behavior:

```text
db:progress -> db:fail:publication mirror failure
actual: [ 'db:fail:diagnostic mirror failure' ]
expected: [ 'db:complete' ]
```

## Implementation

- Scoped diagnostic mirrors now precompute the sanitized serialized payload. After the existing Windows transient rename retries are exhausted, only a scoped mirror performs an in-place write while the existing interprocess lock is still held. The descriptor is flushed, closed, and the temporary file is removed.
- Unscoped writes, non-transient errors, and compare-and-swap writes retain their existing fail-closed atomic behavior.
- `recordProgress()` remains authoritative. Only the subsequent publication-view mirror projection is caught as best effort.
- A detached child that exits successfully is no longer turned into a failed job solely because final diagnostic-mirror persistence fails. Child/provider exit failures still reject normally.

## GREEN verification

All focused commands below used the same external test-only identity shim because of the documented Temp-worktree baseline:

```powershell
$env:NODE_OPTIONS='--import=file:///C:/Users/EDY/AppData/Local/Temp/codex-test-lock-identity-injector.mjs'
npx tsx --conditions=react-server --test tests/agent/sync-job-mirror-atomic-replace.test.ts
```

Result: `pass 7`, `fail 0`.

```powershell
$env:NODE_OPTIONS='--import=file:///C:/Users/EDY/AppData/Local/Temp/codex-test-lock-identity-injector.mjs'
npx tsx --conditions=react-server --test tests/agent/sync-job-worker-handler-lifecycle.test.ts
```

Result: `pass 8`, `fail 0`.

```powershell
npx eslint scripts/lib/sync-job-store.mjs server/services/sync-job-worker-handler.ts tests/agent/sync-job-mirror-atomic-replace.test.ts tests/agent/sync-job-worker-handler-lifecycle.test.ts
```

Result: exit 0 with no lint output.

```powershell
git diff --check
```

Result: exit 0. Git emitted existing CRLF conversion warnings only; no whitespace error was reported.

## Self-review

- The fallback is reached only from `renameMirrorSync()` after it throws, which occurs after its complete retry sequence. It is gated by a non-empty scoped `organizationId`, Windows platform, and the existing transient-error set.
- The fallback reuses the already-sanitized serialized JSON and is inside `mutateSyncJobMirror*`'s held lock. It does not alter compare-and-swap code.
- Both error boundaries are tightly limited to diagnostic/publication mirror operations. `recordProgress`, heartbeat, `complete`, `fail`, and child/provider failure paths stay outside those catches.
- Existing strict tests for persistent unscoped `EPERM`, `EIO`, and compare-and-swap all pass under the fixture environment.

## Concern

This machine's Temp worktree cannot query CIM process identity, so the ordinary focused test command is blocked before mirror code executes. The committed tests and product code do not contain an identity workaround; the external test-only shim was used solely to obtain behavioral RED/GREEN evidence.
