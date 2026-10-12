# Real retry acceptance: report publication repair

Source retry: `97a8b00e-90f4-4078-8190-08745abc6cd8`, project `c4e6e7a4-025a-4ab1-9cf0-858bfc47170d`.

## Observed failure

The retry captured 65 gallery URLs across 10 ASINs (6 or 7 each). Image analysis reported 58 ready of 60 attempted slots. Listing and category records were ready, but canonical display publication rejected price metadata loss:

`Candidate would lose verified data: price_strategy.strategyByAsin.B0CSFDX9HM.provenance`

The project current display remained on job `8ae6c4b7-8e6c-40c1-8610-b20468c3767c`. Its old one-image SellerSprite fallback was therefore still rendered. The Web artifact was applied while the database job failed and the runner mirror claimed completion. Artifact publication is not canonical report publication.

Daily sales data was also lost in the repair-specific path: the generic whole-record cache proxy discarded an error/partial replacement, and a valid daily-only response was incorrectly reported as MCP_SCHEMA because it was not monthly-ready. The normal parser regression did not exercise this repair CLI path.

## Changes

- New direct price captures record actual detail/Price-trend provenance; uncertifiable scoped caches require recapture rather than fabricated same-job metadata.
- Display publication derives captured-stage evidence from verified original price scope/hash. The derived display projection references the original source hash and is rehashed independently. Original stage rows and captured tool results are not changed. It does not claim raw provider tool receipts.
- Stable captured-stage metadata supports legacy → direct → legacy publication. The coverage guard remains unchanged; unknown sources receive no certification.
- Canonical terminal success/failure reconciles the matching mirror. Failed or running jobs cannot claim data published solely because an artifact applied.
- Sales repair uses a per-field reducer, saves valid daily/partial observations, preserves existing data on empty refresh, reuses verified daily fields, and does not describe unavailable monthly data as a schema error.

## Verification and recovery boundary

Actual repair CLI regressions were observed red with missing daily evidence and false schema diagnostics before the fix. Script tests, rendered UI tests, lifecycle/schema tests, disposable PostgreSQL publication tests, and current-display browser tests verify the patch. Final command results are in the task log.

Controlled recovery uses the existing build-only resume service for this failed task; it validates persisted stage hashes/scope and does not dispatch supplier or image-model collection. Do not weaken the coverage guard, overwrite original stage bodies, or force a full recollection to repair this publication error.

Remaining acceptance gaps: supplier natural-month sales semantics, actual persisted sales observations lost by the prior repair, and two failed image-analysis slots. They are distinct from the captured-gallery/publication repair and must not be labeled complete.

## Stranded publication recovery

The real failed task had `currentStageId: build` and `build: done`; generic repository failure had preserved this already-terminal build marker. The existing resume selector therefore found no unfinished stage. The service now advertises/resumes only build for this exact stranded failed shape when the matching mirror provides fully validated scope, fingerprint, all ten outputs and hashes. Repository backfill/ownership checks remain intact. Missing or corrupt evidence cannot resume it. Future publication failures mark the build stage failed without changing sibling outputs. Service regressions 13/13 and disposable PostgreSQL failed/done backfill regressions 2/2 passed.
