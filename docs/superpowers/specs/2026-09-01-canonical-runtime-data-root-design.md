# Canonical Runtime Data Root Design

**Status:** Approved direction. P0 covers the root resolver, formal
manager/launcher, project-store root wiring, and project recovery. P1 covers
the complete atomic Alexa migration and rare-race hardening.

## Problem

The executable code root and the mutable runtime data root currently both follow
the selected Git worktree. Starting the formal stack from a different worktree
therefore silently selects a different `data/` directory. Project history,
Alexa publication snapshots, sync mirrors, and generated application data can
appear to disappear even when the code commit is a descendant of the previous
one. A stale runtime-state file can also disagree with the processes actually
listening on the formal ports.

The approved code baseline is commit `a6a2bc4`. It is a code baseline only:
it does not authorize copying uncommitted generated data or runtime artifacts
between worktrees.

## Goals

- Make formal runtime mutable state independent of the selected code worktree.
- Require a formal launch to declare and record `codeRoot`, `dataRoot`,
  `runtimeRoot`, and the resolved Git `commit`.
- Keep development usable: an explicit data root wins; otherwise development
  retains the existing worktree-local `data/` fallback.
- Make a worktree change fail closed or visibly select the existing shared
  runtime state; it must never silently substitute an empty history.
- Recover the audited historical project set using backup-first,
  hash-checked, exclusive-create, missing-only restoration.
- Defer Alexa publication data to P1, where state, snapshots, projection, and
  cache handling are migrated as one atomic, rollback-capable transaction.

## Non-goals

- The approved P0 restore excludes deployment, provider calls, and real POSTs.
  A controlled restart is allowed only after verification and through its
  separate restart gate.
- Do not copy SQLite databases, generated `app/*-data.ts` files, sync-job
  mirrors, Web runtime/reload artifacts, locks/owners, temporary listing
  images, or other runtime artifacts as a history-restoration shortcut.
- Do not change product, provider, sync, or Alexa business semantics.

## Canonical Roots

The canonical shared root is
`C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime`, with formal
`dataRoot` and `runtimeRoot` resolved beneath it. The formal launcher receives
three absolute paths:

| Root | Ownership | Contents |
| --- | --- | --- |
| `codeRoot` | selected immutable Git worktree | code, dependencies, scripts |
| `dataRoot` | shared mutable runtime location | projects, approved Alexa state/snapshots, generated data |
| `runtimeRoot` | shared formal-control location | launch state, supervisor metadata, locks and formal logs |

Formal mode must reject a missing, relative, worktree-local, or inconsistent
`dataRoot` or `runtimeRoot`. The launcher must pass `AGENT_DATA_ROOT` and
`AGENT_RUNTIME_ROOT` with the same resolved values to every Web and Agent
child. Every formal entry point and data consumer uses this single contract;
formal configuration must not retain competing `APP_*`, `cwd/data`, or
per-launcher defaults.
The formal state record is written atomically beneath
`<runtimeRoot>/state/stack.json`. It adds `codeRoot`, `dataRoot`, `runtimeRoot`,
and `commit` while preserving every existing state field and its semantics:

```json
{
  "codeRoot": "C:\\...",
  "dataRoot": "C:\\...",
  "runtimeRoot": "C:\\...",
  "commit": "a6a2bc4...",
  "version": 1,
  "worktree": "C:\\...",
  "supervisorPid": 1234,
  "supervisorStartTime": "ISO-8601"
}
```

`version`, `worktree`, and any other existing compatibility fields remain
present; the example does not authorize renaming or dropping them.

Secrets, environment values, provider request bodies, and database URLs are
never written to the state record or formal logs.

## Data Restoration Boundary

Before any restoration, stop at a read-only gate and require `active = 0`.
Capture inventories and SHA-256 hashes, then make and verify a complete backup
of the destination data root. The observed inventories are 23 source projects
and 7 live projects, with 6 common IDs and a 24-project union. All 17 source
files absent by ID are missing-only candidates.

Two different IDs share the same ordered marketplace/ASIN scope. Both records
must be preserved; the restored record is explicitly marked as a duplicate for
later adjudication rather than overwritten, renamed, or silently deduplicated.
Same-name or same-scope differences are reported, not treated as file identity.

Each restore creates only an absent destination path using exclusive-create
semantics, verifies the copied hash, and records the exact path and hash in a
rollback manifest. Rollback may remove only manifest-listed files whose hashes
still match. P0 does not copy SQLite, sync jobs, Web artifacts, locks, Alexa
state/snapshots/cache, or generated TypeScript.

P1 migrates Alexa state, every referenced snapshot, the active generated
projection, and required cache policy as one validated atomic transaction with
a rollback journal. No member may be copied independently. Alexa integration
and rare-race handling are explicitly deferred from P0.

## Compatibility and Observability

Development commands may continue without explicit roots and resolve
`dataRoot = <codeRoot>/data` and a local runtime root. Formal commands must
provide both shared roots. Startup output and the safe state file must expose
the four root/commit identities so an operator can compare them with the port
owner before trusting a UI result.

## Verification

Tests must prove:

1. formal launch rejects missing, relative, or code-root-contained data/runtime
   roots before spawning children;
2. formal children receive the same resolved roots and commit, and the state
   file records them atomically;
3. development fallback remains worktree-local only when formal mode is not
   requested;
4. a root mismatch is visible/fail-closed rather than selecting another
   worktree's empty `data/`;
5. inventory/restore derives expected counts from fixtures rather than
   hard-coding 23, preserves both different-ID same-scope records and marks the
   duplicate, requires `active = 0`, and excludes SQLite, sync jobs, Web
   artifacts, locks, Alexa files, and generated TS;
6. exclusive-create, verified backup hashes, and the guarded rollback manifest
   prevent overwrite or deletion of changed files;
7. P1 tests prove the complete Alexa unit commits or rolls back atomically.
