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

Stage 1 committed as `a8fa234`, tag `checkpoint/page-decomposition-stage1-20260910`; independent review Ready.

## Stage 2: presentation/controller boundary

Route entry now 18 lines, workspace view 94 lines, with 16 tab/frame components in nine owning feature files. Controller temporarily retains orchestration for stage 3. 156 original pre-return statements remain identical and ordered; inlining extracted components and ten named UI handlers reproduces original JSX exactly. Dependency and independent lexical-binding checks cover controller return and every component Pick/destructure contract.

Pre-commit checks caught an extraction bug (property names such as length/sort mistaken for free variables) and nineteen new immutability diagnostics from view callbacks writing passed refs. Both were fixed before checkpoint: lexical declarations are independently verified; ten mutation-bearing callbacks now stay in the controller with unchanged bodies, async behavior and captures. No lint suppression or assertion weakening was used.

Final evidence: page dependency graph 24→24 diagnostics, additions zero; relevant lint 11→5 diagnostics, additions zero. Build and built render/data-exclusion checks passed (5/5). Focused source/render tests 31/32 with the same existing ready-empty failure. Auth/bridge source checks 15/15; FBA parsing/source guards10/10. Project/browser checks passed6/6 before callback extraction; final task creation/history4/4 and deleted-workspace race1/1 passed after it. Test source guards now read the actual split production composition via tests/helpers/workspace-source.mjs; browser mock resolution follows moved imports. Source-location assertions retained, with app-tabs import-path expectation updated.

Reproduction/evidence: untracked `page-stage2-*`, `verify-page-stage2.mjs`, `verify-page-stage2-bindings.mjs`. No deployment or GitHub push. Existing screenshots/test artifacts retained.
