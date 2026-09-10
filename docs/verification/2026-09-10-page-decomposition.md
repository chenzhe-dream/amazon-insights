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

Stage 2 committed as `cd2d586`, tag `checkpoint/page-decomposition-stage2-20260910`; independent review Ready.

## Stage 3 and final acceptance

Controller reduced to310lines, composing29 ordered phase hooks/action factories from22 responsibility modules (largest231lines). Related flyout, VOC, runtime and analysis phases share cohesive files rather than one file per tiny phase. Route18lines and view94lines remain. The final public return contract is unchanged; view code was not edited in this stage.

Independent verification expanded all166 original statements in order, restored parameter-only ref aliases and verified each returned property value against its original lexical binding. All external import aliases resolve to the same targets, with no runtime cycle or reverse view dependency. Sixty-six appended effect/callback dependency entries are independently traced to original direct useState setters or useRef objects; no current values, bundles or unstable functions were added. These constant identities preserve effect scheduling. Evidence: untracked `page-stage3-equivalence.json`, `page-stage3-stable-dependencies.json`, `verify-workspace-stage3.mjs`.

Final completed checks (frozen source; browser groups serial):

| Group | Result |
| --- | --- |
| Scope/help/review/repair/primary-admin source and SSR tests |31/32; same preexisting ready-empty message failure|
| Full primary-admin browser suite |10/11; same preexisting runtime-read2-vs-1 failure, reproduced before stage3|
| Auth/bridge/credential source checks |15/15|
| FBA parsing, built rendering and tenant-data exclusion |15/15|
| Sync terminal/repair/scope and production consumers |29/29|
| Full traffic display/session isolation browser suite |24/24|
| VOC evidence browser suite |8/8|
| Deleted-workspace late-response browser case |1/1|
| Legacy local-data bridge source guard |0/1; obsolete source-shape assertion, details below|

Total:133 passing targeted checks,3 failed legacy tests. This is not a claim that all repository tests pass. The local-data bridge guard already fails against original `0fcc192` because it expects the retired direct-observe URL effect. With unused imports removed, it now fails earlier on the `observeVocRun` text check; its assertions were retained. Baseline callback evaluated directly from original Git source using untracked `check-baseline-bridge-assertion.mjs`. Other previously recorded repository debt remains outside this structural change.

Build passed. TypeScript page dependency graph stays24→24 diagnostics, zero additions. Final controller/modules ESLint has zero errors and3 warnings: original authSession.user/closeFlyout warnings plus one newly surfaced clearFlyoutCloseTimer warning because the analyzer loses stable-ref provenance at a hook boundary. That per-render function still closes only over the same stable timer ref, with original body/dependency array unchanged; reviewer confirmed that changing identity or adding an unstable function dependency would be less faithful. No lint rules or assertions were suppressed.

An early baseline sync run overlapped implementation edits and had one execution-context-destroyed failure during HMR. It is not used as final evidence; frozen final29/29 run replaced it. All meaningful runtime/type failures introduced during extraction were corrected before their batch commits. Independent final review Ready with no concrete regression findings.

Final Web/Agent health both HTTP200/status ok, formal source still `5ba042f05633b56c7cf2a35bd20bf5a91de4a3c3`. No deployment, GitHub push or runtime-data changes.

## Rollback use

- Whole-refactor starting point: `checkpoint/before-page-decomposition-20260910` (`0fcc192`).
- Standalone extraction: `checkpoint/page-decomposition-stage1-20260910` (`a8fa234`).
- Presentation/controller boundary: `checkpoint/page-decomposition-stage2-20260910` (`cd2d586`).
- Final passing structural checkpoint: `checkpoint/page-decomposition-complete-20260910` (tag on the final local commit).

For a discovered regression, inspect worktree changes first and revert only the responsible committed batch with Git revert; resolve any conflict without discarding unrelated edits, then rerun its recorded checks. These checkpoints are source rollback points, not database backups. No reset/clean was used; existing untracked screenshots/test-results remain untouched.
