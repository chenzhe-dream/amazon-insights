# ASIN Sync Readiness Repair Design

**Date:** 2026-08-19

**Status:** Approved design; implementation not started

**Scope:** Repair the local ASIN data-sync readiness signal and the two direct data-path failures exposed by the three-ASIN real-data run. Do not redesign the runtime, connectors, or UI.

## Goal

For a submitted ASIN set, the progress funnel must state exactly which of its twelve stages have usable persisted data. A stage whose command exits successfully but persists empty or incomplete content is not complete. The immediate acceptance target is that the current three-ASIN run reports only Alexa VOC as pending (`11 / 12 = 92%`) when the configured real providers return valid data; if any provider still returns no usable data, its own stage must remain visibly failed or pending rather than being counted as done.

## Verified Current State

The three ASINs used for the current local run are `B0C4XRN398`, `B0D2QGKQWV`, and `B0F939J6QC`.

`scripts/lib/asin-data-status.mjs` currently reports five ready fields for each: catalog, keywords, reviews, listing, and traffic. It reports sales, image remarks, and VOC as missing. `app/asin-sync-funnel.tsx` has twelve automatic stages, but `idleStageStatus` falls through to the `sales` field for every stage it does not handle explicitly. Consequently, it also marks child sales, price strategy, FBA, and category as missing even though the corresponding generated data already contains records for all three ASINs. The idle calculation therefore shows `5 / 12 = 42%`; it is a false undercount, not an accurate statement of the successfully persisted modules.

Two real data-path defects account for the remaining non-Alexa gaps:

1. A read-only Sorftime response for the sales trend is shaped as `{ data: string[] }`. `parseSorftimeTrend` accepts a string (including the old string-valued `data`/`content` form) but not the current array-valued `data`, and produces an empty trend. The sales stage command can therefore exit zero while `app/sorftime-sales-trend-data.ts` persists `status: "empty"`.
2. `scripts/build-listing-image-remarks.mjs` posts image analysis to the hard-coded official OpenAI endpoint. The local environment uses a relay `OPENAI_BASE_URL`, so the configured relay credentials and base URL are not used by the image-remarks command. Existing generated remarks are incomplete for the three ASIN galleries.

Alexa VOC is intentionally not repaired here. It remains a distinct manual/missing stage until its independently scoped implementation is available.

The separate report that only a primary image is visible is not evidence of a Sorftime listing-fetch failure. The real `product_detail.main_image` value is a JSON string and the current `parseImageList` implementation parses it into the complete gallery. The existing generated listing export persists 8, 9, and 6 gallery images respectively for `B0C4XRN398`, `B0D2QGKQWV`, and `B0F939J6QC`, with matching `secondaryImages`. The UI's `resolveGallery` consumes `galleryImages` when a fresh bundle includes the generated export.

The confirmed cause is asset freshness: the production Web bundle was built before the generated listing file changed. The sync job ran under `AGENT_VOC_LOCAL_FAKE=1`, which intentionally skipped its production build/restart step; a browser reload therefore kept executing the old bundle and fell back to the primary image. This is not a reason to alter the Sorftime request/response protocol or to manufacture secondary images.

## Approved Approach

Implement the smallest coherent repair in four boundaries.

### 1. Independent readiness for all twelve stages

Expand the shared ASIN status contract in `scripts/lib/asin-data-status.mjs`, `app/lib/sync-server.ts`, and the client mirror in `app/asin-sync-funnel.tsx` so each automatic stage has an independently derived `ready | missing` state:

| Stage | Readiness source | Complete only when |
| --- | --- | --- |
| catalog | `competitor-data.ts` | ASIN exists in the catalog |
| keywords | SIF keyword export | record status is `ready` |
| reviews | Sorftime review export | record status is `ready` |
| sales_trend | Sorftime sales trend export | record status is `ready` and contains usable trend data |
| child_sales | child-sales/variant export | persisted child-sales data exists for the ASIN |
| price_strategy | price-strategy export | persisted price-strategy record exists |
| fba | FBA-fee export | persisted fee record is usable |
| listing | Listing-content export | ready record has at least one analyzable gallery image |
| image_remarks | listing-image-remarks export | every analyzable gallery image has a nonblank remark |
| category | category-trend export | persisted category-trend record exists for the ASIN |
| alexa_voc | `rufus-voc-data.ts` | existing dialog capture predicate succeeds; otherwise manual/missing |
| traffic | SIF listing-traffic export | overview total and structure dimensions are usable |

`idleStageStatus` maps each stage ID to that specific field. It must not use `sales` as a fallback for unrelated stages. The percentage remains the twelve-stage arithmetic and is rounded only after the count is correct.

### 2. Backward-compatible Sorftime trend parsing

`scripts/lib/sorftime-trend-parse.mjs` makes `parseSorftimeTrend` accept all currently supported representations:

- a comma-joined string;
- legacy object strings in `data` or `content`; and
- the real current `{ data: string[] }` response, including an array supplied directly if a connector returns one.

All forms normalize through the existing trend-part parser, retaining only valid month/value pairs. Invalid, empty, or malformed payloads remain empty and therefore cannot make the sales-trend stage ready.

### 3. Safe relay-aware image analysis

`scripts/build-listing-image-remarks.mjs` derives its chat-completions endpoint from a safely normalized `OPENAI_BASE_URL`:

- default: the official `https://api.openai.com/v1` base;
- configured base: parse with `URL`, require `http:` or `https:`, reject embedded credentials and fragments, normalize the path to one `/v1`, then append `chat/completions` without duplicate or missing slashes;
- never write the base URL, authorization header, key, model request body, or provider response into generated output or user-facing errors.

The model choice is deterministic: `OPENAI_VISION_MODEL`, then `AGENT_VOC_MODEL`, then `gpt-4o-mini`. This reuses the existing `OPENAI_API_KEY` only; it introduces no new secret, connector, SDK, or configuration file. A relay response that lacks vision support, returns a non-OK response, or produces invalid/incomplete per-image remarks leaves that ASIN's `image_remarks` stage missing/failed with a safe summarized error.

### 4. Persisted-data postconditions for sync jobs

`scripts/run-asin-sync-job.mjs` treats a subprocess success only as permission to evaluate the stage postcondition. It reevaluates the affected ASINs through the same canonical status helpers before marking a stage done and before recording per-ASIN module progress.

For every stage, these rules apply:

- all affected ASINs ready: mark `done`;
- any affected ASIN missing after a zero-exit command: mark the stage `failed` (or `skipped` only for an explicitly unavailable configuration) and record a non-secret, ASIN-counted reason;
- do not mark a proxy field as ready for another stage;
- retain already successful sibling stages and continue only where the existing job semantics permit it; do not synthesize success to make the overall percentage look better.

Alexa remains `manual` when absent. It is not converted to an error and it is not included in any connector retry introduced by this repair.

### 5. Rendering-freshness acceptance boundary

This repair does not change the local-fake build policy, add automatic restart behavior, or migrate generated data into a runtime data API. Those are separately scoped runtime-policy decisions. Instead, the tracer acceptance procedure must distinguish persisted listing data from an outdated Web bundle:

1. A focused test proves `parseImageList` preserves every valid entry from a JSON-string `main_image` list and retains legacy direct-array/string behavior.
2. After a real sync, perform a fresh production build plus one controlled Web-stack restart, or run the supported development server with HMR active; then reload the page.
3. For each of the three ASINs, inspect the rendered gallery and confirm more than one image is visible. If a fresh bundle still renders only the primary image while `galleryImages` has multiple URLs, report that as a separate UI-rendering defect rather than a connector or readiness failure.

No synchronization-policy change is authorized by this design. If the controlled-build requirement proves too disruptive for normal local use, record that as a follow-up concern; do not silently extend this repair into automatic restarts or a data-API migration.

## Non-Goals and Safety Boundaries

- No runtime/Agent Service refactor, connector redesign, new UI, package dependency, migration, database change, or production deployment work.
- No change to the Sorftime listing protocol, no synthetic gallery/secondary images, and no automatic Web restart or generated-data API migration.
- No change to login, authorization, Cloudflare, PostgreSQL, concurrency, or audit behavior.
- No fabricated fixture data and no override that turns an empty provider result into readiness.
- Existing dirty generated exports, `docs/runbooks/agent-stack.md`, `data/*.sqlite`, `data/projects/*`, `.superpowers/`, and any stash are user-owned state. Implementation must neither edit them intentionally nor stage/commit them.
- No `reset`, `checkout`, `stash`, `clean`, `amend`, `rebase`, or `push` operation is part of this work.

## Intended File Boundary

Implementation may change only the following source/test areas, subject to the non-goals above:

- `scripts/lib/asin-data-status.mjs`: source paths and independent per-stage predicates.
- `scripts/lib/sorftime-trend-parse.mjs`: array-aware trend normalization.
- `scripts/build-listing-image-remarks.mjs`: normalized base URL and model selection.
- `scripts/run-asin-sync-job.mjs`: canonical postcondition checks before stage completion.
- `app/lib/sync-server.ts` and `app/asin-sync-funnel.tsx`: shared/client status shape and explicit stage-to-field mapping only.
- Existing focused tests plus narrow new tests under `tests/scripts/` or `tests/agent/`; no generated data files.

## TDD and Acceptance

Implementation starts with focused failing tests and proceeds one behavior at a time.

1. **Trend parser:** `{ data: ["2026年01月=12", "2026年02月=13"] }`, a direct string array, and legacy string payloads produce the same valid normalized records; malformed entries are ignored and all-invalid input produces an empty result.
2. **Readiness contract:** a status fixture can independently mark child sales, price strategy, FBA, and category ready while sales trend is missing. The funnel reports `9 / 12 = 75%` for the observed pre-repair state, rather than `42%`.
3. **Image endpoint/model:** default base resolves to the official `/v1/chat/completions` endpoint; a valid relay base resolves to its own single `/v1/chat/completions`; invalid scheme, credentials, or fragment is rejected safely; model precedence is vision override, then VOC model, then fallback.
4. **Stage postconditions:** a zero-exit command followed by empty sales data or incomplete image remarks does not create a done stage or a ready per-ASIN field. A zero-exit command followed by canonical ready data does.
5. **Alexa preservation:** missing Alexa stays manual/missing and never causes the other eleven stages to be downgraded.
6. **Listing freshness:** a focused parser test preserves every image from a JSON-string `main_image` payload. The final three-ASIN tracer uses a fresh production build plus controlled restart (or development HMR) before asserting each rendered gallery has more than one image.

Manual local acceptance uses the same three ASINs, the existing private `.env.local`, and no secret output. Start a fresh sync after the focused tests pass. With valid real connector/model responses, all non-Alexa stages must persist usable content and the idle funnel must show `11 / 12 = 92%`, with exactly the three Alexa ASINs pending. Before any visual gallery assertion, produce a fresh Web bundle and perform one controlled restart, or use development HMR; each ASIN must render more than one image. If Sorftime or the vision relay still returns unusable content, retain a truthful failing stage and capture only its provider-neutral reason; if a fresh bundle still shows only a primary image, report the distinct rendering failure. Do not claim the 92% target for an unresolved required stage.

## Completion Boundary

The repair is complete only after focused tests pass, `git diff --check` passes, and a new three-ASIN local run demonstrates either the truthful 92%/Alexa-only state or a precise remaining connector/provider failure. The current dirty generated artifacts are evidence inputs for manual validation only and are excluded from every implementation commit.

## Design Self-Review

- **Placeholders:** none; the endpoint, model precedence, stage semantics, and acceptance state are explicit.
- **Consistency:** the same canonical status predicates drive idle display and runner postconditions; Alexa is consistently manual/missing.
- **Scope:** restricted to correctness of readiness, parsing, image relay use, job completion semantics, and an explicit freshness-aware acceptance procedure; automated restart and data transport remain out of scope.
- **Ambiguity resolved:** a successful subprocess is not successful data synchronization unless its persisted per-ASIN predicate passes.
