# Formal VOC Page Bridge Design

**Date:** 2026-08-15  
**OpenSpec scope:** `build-standalone-agent-workflow` task 8.4, first vertical slice  
**Status:** Approved for planning

## Goal

Replace the browser's fake-only VOC tracer with one durable submission and
read path that works with both the local fixture provider and the configured
OpenAI provider. A user can submit the current ASIN set, see the persisted VOC
stage state and report, refresh the page, and recover the same run.

This slice proves the minimum formal page boundary. It does not complete all of
OpenSpec 8.4: report history browsing, manual retry, and cancellation remain a
follow-up before 8.4 can be checked.

## Current constraints

- The page currently posts to `POST /v1/local-voc`, polls the formal run/report
  read endpoints, and stores only a one-line result in React state.
- `POST /v1/local-voc` is registered only when
  `AGENT_VOC_LOCAL_FAKE=1`, even though the Worker runtime already selects its
  provider from Agent Service configuration.
- The local route already creates the trusted SQLite project, run, immutable
  VOC snapshot, stage, and job required by the 8.3 Worker.
- The generic `POST /v1/projects/:projectId/runs` path does not currently create
  a VOC snapshot before its job becomes claimable. Replacing the local route
  with that path in this slice would introduce a snapshot/claim race and expand
  the task beyond the approved tracer bullet.
- Data acquisition progress and analysis-run progress are distinct. The page
  must not present SIF/Sorftime sync progress as VOC Skill execution progress.

## Chosen approach

Keep `POST /v1/local-voc` as a small composition endpoint, but remove its
fixture-only meaning. Rename its code-level concepts to formal VOC submission,
register it whenever the SQLite repository and execution context are available,
and let the existing Agent runtime decide whether the provider is the local
fixture or OpenAI.

The endpoint remains an adapter over existing 8.1-8.3 services and repository
contracts. It must not implement a second Skill runner, report store, or Worker.

## Components

### Agent submission boundary

The submission boundary validates marketplace and ASINs, verifies that the VOC
runtime is available, and performs the existing trusted creation sequence:

1. Resolve repository VOC input for the requested ASIN set.
2. Create the organization-owned SQLite project and analysis run.
3. Persist exactly one immutable VOC DataSnapshot for that run.
4. Create the `voc-positioning` stage and enqueue one Worker job only after the
   snapshot is durable.
5. Return both `projectId` and `runId`.

Missing VOC input returns a structured `waiting-input`-class response with no
fake success. An unavailable runtime returns a structured, non-secret 503 before
creating a run that cannot be processed.

The provider remains outside the route:

- `AGENT_VOC_LOCAL_FAKE=1` selects the deterministic local fixture provider.
- Normal configured mode selects the existing OpenAI provider.
- The response and ordinary logs never reveal API keys or proxy tokens.

### Browser analysis state

The page owns a small analysis-run state separate from the data-sync funnel:

- `idle`
- `submitting`
- `queued` / `running`
- `waiting-input`
- `failed`
- `succeeded`
- `offline`

After a successful submission, the page writes the returned run identifier to
the current URL as `run=<uuid>`. It then polls the existing formal endpoints:

- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/reports`
- `GET /v1/reports/:reportId` when full report detail is required

On page load or refresh, the URL run identifier is read first. The page queries
SQLite through Agent Service and restores the same stage/report instead of
submitting another run. A missing or unauthorized run produces a clear terminal
message and removes no persisted data.

### Minimal report presentation

The existing VOC area receives the saved report rather than generating another
conclusion in the browser. This slice displays:

- current `voc-positioning` stage status and progress;
- structured last error or waiting-input action;
- report version and creation/cutoff metadata;
- the persisted core conclusion/strategy;
- an explicit `fixture` or configured provider label when available from saved
  execution metadata.

The data-sync progress panel remains unchanged and visually separate.

### Offline behavior

Network refusal, timeout, or a failed Agent health check becomes an `offline`
state. The page displays an actionable local instruction such as
`npm run agent:dev`, while preserving the run identifier so a later refresh can
recover it. It must not collapse offline errors into an unknown VOC failure.

## Error semantics

- Validation errors identify the rejected ASIN/input without creating a run.
- Missing VOC data is `waiting-input`, not `succeeded` and not a fabricated
  report.
- Provider, budget, and Worker errors are rendered from the persisted stage's
  structured safe error.
- A poll timeout stops browser polling but does not mutate or cancel the durable
  run.
- Report publication is considered successful only when the formal report read
  endpoint returns the persisted report.

## Testing and acceptance

Implementation uses TDD at the real boundaries:

1. Route tests prove the submission endpoint is available in fixture and normal
   configured modes, unavailable runtime fails before mutation, and one request
   creates the expected project/run/snapshot/job identity.
2. Browser-state tests prove submission stores the run in the URL, equivalent
   rerenders do not duplicate POSTs, refresh restores by `runId`, and offline
   errors preserve recovery information.
3. A single local fixture smoke starts Web and Agent without visible child
   consoles, submits known VOC fixture ASINs, polls to a persisted report, then
   reloads and reads the same report/version without a second provider call.

Only focused tests and this one smoke are required for the slice. Real OpenAI
execution belongs to OpenSpec 8.5 and is not required to accept this change.

## Non-goals

- Report history list, stage retry, and cancellation controls.
- Alexa/browser automation or new VOC acquisition.
- Traffic and final-product Skill execution.
- Login, PostgreSQL, Cloudflare, or production deployment.
- Replacing generated TypeScript data with production connector storage.
- Marking OpenSpec 8.4 or 8.5 complete.

## Follow-up

After this slice is verified, finish the remaining 8.4 controls and history
view. Then perform 8.5 with a valid OpenAI key and proxy configuration, proving
`existing data -> Skill -> OpenAI -> SQLite -> page -> refresh` on the same
formal path.
