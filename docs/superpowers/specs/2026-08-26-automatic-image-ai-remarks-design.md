# Automatic Image AI Remarks Design

**Date:** 2026-08-26

**Status:** User-approved design

## Goal

Automatically generate Chinese AI remarks for every valid static main and secondary Listing image after the core US ASIN analysis has completed, without allowing image-model failures to block or erase the already successful business analysis.

## Isolation and scope

Implementation starts from pushed stable commit `1a68a47c5abb3a005c959334876c135a1497118c` in the isolated worktree `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\image-remarks-auto-run` on branch `codex/image-remarks-auto-run`. The live `stabilize-resumable-sync-pipeline` worktree, its generated runtime data, PostgreSQL, and the running Web/Agent services remain untouched until a separately approved controlled deployment.

This change re-enables and hardens the existing `image_remarks` stage. It does not create a second job system, database migration, new Provider integration, or changes to SellerSprite, Sorftime, SIF traffic, Alexa VOC, authentication, or project identity.

## Chosen architecture

Use the existing `image_remarks` sync stage and existing OpenAI-compatible image-remark adapter. The ordered pipeline is:

`Listing gallery ready -> traffic terminal -> image_remarks automatic stage -> build/publication -> page refresh visibility`

The release runner must no longer convert missing image remarks to a disabled/manual stage. It invokes image analysis only after every requested ASIN has reached a terminal traffic result. The image stage uses the existing canonical per-ASIN module and stage status contracts, resource governor, generated remarks export, build, and publication path.

Rejected alternatives:

- A detached post-job background task is rejected because it would introduce a second lifecycle and recreate refresh/recovery ambiguity.
- One multi-image request per ASIN is rejected because an unbounded gallery can exceed model limits and makes one bad image fail the whole ASIN.
- Browser-side image analysis is rejected because it would expose credentials and lose server-side audit, timeout, and recovery boundaries.

## Image selection and cache behavior

- Analyze every valid static image in the persisted Listing gallery; there is no per-ASIN image-count cap.
- Preserve gallery order so array index zero remains the main image and later indexes remain secondary images.
- Video/play-button thumbnails are not sent to the model and retain the existing fixed non-analysis note.
- A nonblank existing remark for the same ASIN and slot is reused. Automatic runs only call the model for missing static-image remarks.
- `--force` remains an explicit administrative/manual command behavior and is not used by the automatic sync path.
- Missing or empty Listing galleries produce a truthful `upstream-empty` image module result and no model call.

## Execution limits

- The whole sync job has a global maximum of four in-flight image requests, not four per ASIN.
- Each static image has one total 120,000 ms deadline covering resource-governor admission and the physical model request. No hidden shorter default request timeout may terminate the normal path before that deadline.
- Each image receives at most one physical model call in an automatic run. There is no automatic retry, replacement request, or second image job.
- Every physical call remains exactly accounted by the existing resource governor under the `image` resource.
- The existing model precedence and OpenAI-compatible endpoint normalization remain unchanged; credentials, base URLs, headers, request bodies, and provider bodies are never logged or persisted.

## Result and failure semantics

Results remain isolated per image and aggregate truthfully per ASIN:

- valid nonblank structured remark: `ready` and persist the remark immediately in the generated export;
- provider returns no usable remark: `upstream-empty`;
- total deadline expires: `timeout` with the fixed safe 120-second reason;
- governed request, transport, HTTP, or schema failure: `connector-failed` with a fixed safe reason;
- video thumbnail: no call and the existing fixed video note.

Successful sibling images and existing remarks are retained when another image fails. After all queued images settle, the image stage may be `done` or `partial`, but image gaps must not downgrade completed catalog, keywords, reviews, sales, Listing, category, or traffic data. The sync job can reach its normal terminal completion with an explicit completed-with-gaps presentation. The UI reports completed, processing, timeout, connector failure, and missing counts without claiming that failed images were analyzed.

The build/publication stage runs after the image queue settles so persisted remarks become visible after refresh. A publication failure follows the existing build/publication contract; it is not hidden as an image-model success.

## UI behavior

- `image_remarks` returns to an automatic progress row and no longer displays `已停用，待后续分析` for newly submitted jobs.
- While running, the page shows completed images versus total analyzable static images and the global concurrency does not change that denominator.
- On terminal completion, every available gallery image remains visible even when its AI remark is absent.
- Ready remarks render under their matching image slot. Failed slots show a concise, provider-neutral status and do not borrow another image's remark.
- Refresh restores the authoritative job/module result and generated remarks; it must not start another image request.

## TDD and acceptance

Implementation begins with focused RED tests and covers:

1. The production runner orders terminal traffic before automatic `image_remarks`, then build/publication.
2. Galleries of arbitrary finite length enqueue every valid static image, skip video thumbnails, preserve slot order, and reuse existing nonblank remarks.
3. Across three ASINs, measured in-flight physical image requests never exceed four.
4. A single image receives one physical request, uses a 120,000 ms total deadline, and is never automatically retried.
5. One timeout, connector failure, empty response, or invalid response does not prevent later images or sibling ASINs from completing and being persisted.
6. Missing configuration or an unavailable image model produces safe gaps and zero secret/body leakage while the core analysis remains complete.
7. The page exposes automatic image progress, preserves the gallery without remarks, aligns remarks by slot, and restores terminal state on refresh without a POST.
8. Existing SellerSprite, Sorftime, SIF traffic, Alexa manual behavior, project identity, auth, and generated-data publication tests remain unchanged and pass.

The implementation gate is focused RED-to-GREEN evidence, changed-file lint/type diagnostics, one production build, strict OpenSpec validation where applicable, scoped diff checks, and one independent review limited to Critical or direct business blockers. No real image-model request, deployment, browser business POST, or new job is allowed before that review and a separate deployment approval.

Controlled post-deployment acceptance uses a new or explicitly approved project once. It verifies all static gallery images are attempted at most once, global concurrency never exceeds four, the 120-second deadline and failure isolation are observable, ready remarks appear after refresh, and existing traffic/core results remain intact. Partial image remarks are an accepted truthful outcome only when every missing slot has a fixed reason.

## Design self-review

- **Placeholders:** none.
- **Consistency:** automatic execution, all static images, global concurrency four, 120-second total timeout, zero retry, and non-blocking failure semantics are used throughout.
- **Scope:** one existing stage and its tests/UI contracts; no second lifecycle or unrelated connector work.
- **Ambiguity resolved:** “all images” means all valid static gallery slots with no numeric cap; “non-blocking” means core modules remain complete while image gaps are explicit; “120 seconds” is the effective total per-image deadline, not merely an outer timer with a shorter inner timeout.
