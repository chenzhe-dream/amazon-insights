# VOC Analysis Recovery Design

## Goal

Make the existing Manual Alexa VOC workflow produce a truthful, diagnosable VOC analysis result instead of failing import, remaining visually active after polling stops, or collapsing provider failures into an unhelpful generic error.

## Confirmed Baseline

- The current three-ASIN scope has zero persisted Manual Alexa VOC revisions because all three import requests returned HTTP 422.
- The page can retain an `active` observation after its bounded polling loop ends even though no active VOC stage exists.
- Historical run `9b1e6c8c-e8ec-4139-a7b6-87393be7f73d` created a real `voc-positioning` stage, but the relay model request failed before a response id was received and persisted only `UPSTREAM_PERMANENT`.

## Design

### Selected-ASIN Binding

The selected request ASIN is the authoritative scope when an Alexa report does not repeat an ASIN in its text. An explicitly present ten-character ASIN must still match exactly; an explicit mismatch remains HTTP 422. Existing report-size and minimum-three-dimension validation remains fail-closed.

### Terminal State Tracking

VOC polling must cover the existing maximum bounded execution window rather than stopping after about fifteen seconds. It continues GET-only observation until the run reaches `waiting-input`, `failed`, or `succeeded`, and publishes every observation to the page. It does not submit, retry, or create a replacement run.

### Safe Provider Diagnostics

OpenAI-compatible HTTP errors retain only a bounded status class as diagnostic metadata. The persisted API error uses fixed reason codes for authentication, rate limiting, request rejection, and upstream service failure; it never stores response bodies, headers, URLs, credentials, or arbitrary provider messages. Existing request accounting and retry rules remain unchanged.

## Constraints

- Require complete Manual Alexa records for all 3-10 ASINs before VOC submission.
- Do not accept arbitrary prose without at least three valid dimensions.
- Do not make real Provider requests during implementation tests.
- Do not auto-submit, auto-retry, or create replacement jobs/runs/stages.
- Do not stage the 15 generated `app/*.ts` files or the current project JSON WIP.

## Acceptance

1. A valid three-dimension report without an embedded ASIN imports under the selected ASIN.
2. The same report with a different explicit ASIN is rejected before encryption or database writes.
3. A run that lasts longer than fifteen seconds continues GET-only observation and eventually renders its real terminal state.
4. Relay HTTP 400/401/403/429/5xx failures persist only their fixed safe reason category.
5. Focused regression tests, affected tests, lint, production build, and diff-check pass.
