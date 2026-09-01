## 1. P0 Gallery and image remarks

- [x] 1.1 Add RED fixture tests proving a six-ASIN Sorftime catalog response loses auxiliary images today, image remarks performs zero requests, empty gallery is `upstream-empty`, and repeated ready/terminal reconciliation does not reactivate work.
- [x] 1.2 Implement the bounded job/scope evidence envelope and persist the full normalized `product_detail` gallery from Sorftime catalog fallback.
- [x] 1.3 Make listing consume matching evidence before a network call, persist main and all auxiliary URLs with provenance, and make image-remarks activation idempotent per job/ASIN.
- [x] 1.4 Update the listing image presentation so upstream-empty and gallery-ready-but-analysis-pending cannot render as completed.
- [x] 1.5 Run P0 focused tests, review only the P0 diff against the spec, fix Critical/Important/direct blockers, record Minor as deferred, and create one atomic P0 commit.

## 2. P1 Five Sorftime module fallbacks

- [x] 2.1 Add RED tests for normal-result precedence, exact job/marketplace/ASIN/operation matching, stale evidence rejection, verified empty versus connector failure, and required provenance fields.
- [x] 2.2 Add bounded evidence adapters for FBA, Listing, price strategy, category, and child sales without weakening provider validation or fabricating insufficient results.
- [x] 2.3 Make current-job builders use normal success first and matching Sorftime evidence second; prevent legacy cache from being labelled as current-job output.
- [x] 2.4 Run P1 focused tests, review only the P1 diff against the spec, fix Critical/Important/direct blockers, record Minor as deferred, and create one atomic P1 commit.

## 2A. Sealed generated-result recovery

- [x] 2A.1 Add RED tests for manifest-SHA verification, exact six-ASIN selection, enrichment reference selection, preserved collisions, excluded missing-result exports, and unchanged shelf-light baseline digests.
- [x] 2A.2 Implement a prevalidated record-level missing-only merge for catalog, SIF keyword/enrichment/traffic/monthly, and Sorftime review/rating; never copy whole files or restore sales/listing/image/VOC data.
- [x] 2A.3 Execute the tool against the sealed pre-switch backup, emit a payload-free recovery manifest, verify 6/6 ASIN coverage and 143/143 referenced enrichment coverage, and keep the existing shelf-light records unchanged.
- [x] 2A.4 Assess the shared-runtime/publication seam without weakening the launcher's containment invariant, run focused tests, review the recovery diff, fix Critical/Important/direct blockers, and create one atomic recovery commit.

## 3. P2 Environment credential UX

- [x] 3.1 Add RED API and UI tests proving environment source currently hides managed switching, primary-admin PUT can safely create a managed version, unauthorized requests fail secret-free, and formal paths expose names but no values.
- [x] 3.2 Expose a confirmed one-time environment-to-managed switch for all three connectors, clear the secret after save, immediately probe, and show whether restart is required.
- [x] 3.3 Show the exact formal configuration path, connector variable name, restart step, and re-probe step while environment remains authoritative; wire managed runtime resolution to new sync subprocesses without logging the secret.
- [x] 3.4 Run P2 focused tests, review only the P2 diff against the spec, fix Critical/Important/direct blockers, record Minor as deferred, and create one atomic P2 commit.

## 4. Unified verification

- [ ] 4.1 Run the combined affected test set and a fixture end-to-end six-ASIN catalog-gallery-image-analysis flow with fake connectors and a fake image endpoint.
- [ ] 4.2 Run changed-file ESLint, exactly one production build, strict OpenSpec validation, and scoped diff checks.
- [ ] 4.3 Perform final independent review, fix only Critical/Important/direct blockers, and report commits, tests, SIF modification paths/restart rules, conflict-prone files, and deferred Minor findings without push or deploy.
