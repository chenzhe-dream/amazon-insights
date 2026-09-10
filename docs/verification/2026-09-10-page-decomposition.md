# Page decomposition evidence and rollback ledger

Starting checkpoint: `0fcc192`, tag `checkpoint/before-page-decomposition-20260910`. User authorizes completing the decomposition with per-batch rollback safeguards. No GitHub push or deployment.

## Stage 1: standalone declarations

Extracted 45 declarations into 13 cohesive catalog/chart/project-navigation/VOC/traffic/shared-display modules. Main page shrank from 3865 to about 2550 lines. Original authenticated application and Home bodies remain identical. All 51 original top-level declaration bodies (45 extracted plus 6 retained) compare equal; extracted imports resolve, with no reverse page dependency or runtime cycle. Evidence under untracked `test-results/page-stage1-*` and `verify-page-stage1.mjs`.

- Traffic/display/scope browser suite: 24/24 passed.
- Focused scope/help/gap/repair/review/primary-admin tests: 31/32 passed. The one failure already reproduced before extraction: `primary-admin-page.test.ts`, Sorftime ready-empty case expects its raw status message but current UI emits the generic no-samples message. Assertion retained. This is additional existing debt, not silently fixed or suppressed.
- Build passed; built render/tenant-data checks 5/5 passed.
- Page dependency graph: 24 baseline and 24 current TypeScript diagnostics, no additions.
- Page plus extracted modules lint: 16 baseline and 15 current diagnostics, no added rule/message instances after stripping source location/code frames; existing debt remains. Source-body equivalence independently proves the shifted effect text unchanged.
- Test imports/read locations updated for extracted named components, without changing assertions.

Subsequent stages and exact checkpoint commits are recorded below as they pass.
