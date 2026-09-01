# One-shot Artifact Refresh Design

## Goal

When a sync job reaches terminal state and its immutable Web artifact is confirmed as `publication.status=applied`, make an already-open browser converge to that artifact automatically at most once. The refresh must never submit another sync job, call a Provider, or form a reload loop.

## Root Cause

Image AI remarks are generated into the immutable Web artifact. A page opened before publication keeps its old client bundle. The current client deliberately shows a manual refresh notice after publication instead of navigating, so the old page can display a newly loaded gallery with an old, empty remark map.

## Chosen Design

The browser stores a scoped one-shot claim keyed by normalized scope, `jobId`, and target `artifactId` in the existing terminal session owner. After stage outputs settle and publication becomes `applied`:

1. Record the terminal tuple before any navigation.
2. If the current document artifact already equals the target, do nothing.
3. If they differ and the tuple has not claimed a refresh, atomically claim it and replace the current URL once. The replacement temporarily adds `webArtifact=<target>` as a cache-busting marker while preserving every existing query parameter.
4. On remount, restore the same `syncJob` from the URL and session tombstone and use GET only. Once the document artifact equals the target, remove only the temporary `webArtifact` marker with `history.replaceState`.
5. If the artifact still differs after that claim, stop automatic navigation and show the existing manual refresh notice.

The same canonical URL is retained, including project, tab, `run`, and `syncJob` identity. Only an explicit user restart may clear the terminal owner.

## Invariants

- Publication `pending`, `failed`, missing, or malformed artifact identifiers never trigger navigation.
- Current artifact equal to target triggers zero navigation.
- Each scoped `(jobId, artifactId)` triggers at most one full-page navigation across callback duplication, React Strict Mode, and remount.
- Navigation and recovery produce zero POST requests, zero Provider calls, and zero new job/run/stage records.
- The Supervisor remains the only component that replaces the Web process; the browser only reloads a document already acknowledged as applied.
- A failed terminal-record write fails safe to the manual notice instead of automatic navigation.
- Existing stage-output settlement, polling, scope validation, and explicit restart behavior stay unchanged.

## Failure Display

This slice fixes stale client consumption only. Images whose persisted result is `connector-failed` remain explicit failures and must not be presented as successful AI remarks. Targeted image-only retry and dynamic PostgreSQL/API delivery are separate later slices.

## Tests

- Pure decision: invalid/same target => no action; first mismatch => reload; claimed mismatch => manual fallback.
- Session owner: first claim succeeds; duplicate callback and remount fail; different scope is isolated; terminal recording preserves the claim; explicit restart clears it.
- Browser: pending keeps GET polling and never navigates; applied mismatch navigates once; remount stays GET-only and never navigates twice; applied same artifact does not navigate; publication failure never navigates; all paths keep POST count zero.

## Acceptance

After a generated artifact is applied, an old page automatically loads it once and displays its image AI remarks. If convergence fails, the page stops and asks for a manual refresh rather than flashing repeatedly.
