# Product definition inline reading implementation plan

**Goal:** Apply the approved local V2 preview to sections 1, 4, 5, 6 and 7 of the existing local product definition report.

**Current approved revision:** Restore the original frontend template. Remove per-row decision columns in sections 4/6/7 and per-item controls in section 5. Keep ASIN-separated inline text, VOC excerpts, pending validations, the existing collapsed rule overview and saved trace data. Earlier disclosure tasks below are historical iterations and do not authorize restoring those controls. Reuse the application's actual navigation template and icons in the preview; no simplified replacement sidebar.

**Architecture:** Isolated presentation components expand the existing text nodes and render scoped saved decisions. Table decisions occupy a sibling row with the correct column span; feature decisions remain beneath their item. No model, API, persistence or analysis changes.

**Checkpoint:** Local commit `4494ea7531f8051f225d53fee9c02132b690a58a`; initial UI implementation at `70788a1797a4eee21000797c39d5198d0a21c135`. The mistakenly pushed remote branches were removed at the user's request. Further work is local only; no remote pushes or repository changes without an explicit destination. Current worktree branch/index preserved because the main thread shares this checkout.

**Execution:** Implement sequentially in this side conversation; do not delegate or touch the main thread's agents.

## Constraints

- Preserve exact report text, ASIN boundaries, source references, result statuses and rule snapshots.
- Expand text in place, with no drawer and no duplicate full-text copy.
- Match the current frontend theme. Scope all additional styles to this report.
- Show unknown/rejected conditions and pending checks explicitly; do not hide them behind positive summaries.
- Keep historical missing-trace states honest. Never use an unrelated ASIN/source or current rule catalog to fill a missing saved record.
- Source files only; do not deploy, consume analysis quota or change the backend in this task.

## Tasks

- [x] Preserve pre-change checkpoint locally; run existing saved-report snapshot regression. Remote copies subsequently withdrawn at the user's request.
- [x] Add meaningful regressions for scope isolation, preserving text and absent historical traces.
- [x] Add reusable inline text, decision content, feature disclosure and expandable table row components, plus isolated styles.
- [x] Wire sections 1/4/5/6/7 without changing report generation or other modules.
- [x] Verify browser interactions, in-place text identity, source scoping, keyboard controls, mobile layout and TypeScript/lint; rerun saved-report regression.
- [x] Review the change against the checkpoint and prepare the completed scope and limitations for handoff.

## Verification

- Seven passing tests across `product-definition-inline.test.tsx`, `product-definition-inline-browser.test.ts` and `local-product-definition-snapshot.test.tsx`.
- TypeScript check and ESLint passed on 2026-09-17.
- Chromium verified keyboard expansion, unchanged text nodes, correct table column spans, scoped evidence, focus return and a 390px viewport without page overflow.
- Visually inspected the implemented components using the previous screenshot-derived long-content fixture. Fixed inherited card stretching, text sizing and list markers.
- Local implemented-component preview uses illustrative data, not production responses. No production deployment, backend changes or paid analysis calls were made.

## Local reading refinements

Scope remains sections 1/4/5/6/7. Modify the existing presentation component and its stylesheet; extend the same browser harness and regression. Preserve original text and decision references.

- [x] Separate ASIN labels from clamped body text in cards and the complete definition; retain the exact text and inline expansion.
- [x] Show two available references initially; expand the rest in the same evidence area. Keep unavailable sources and pending checks visible.
- [x] Add a bottom collapse control to table/feature details, returning focus to their original trigger.
- [x] Verify text identity, overflow detection, source visibility, focus return, mobile layout, types and lint; refresh the local preview only.

Refinement validation: all seven regression tests passed, including the extended real-browser scenario with four scoped sources and an unavailable reference. TypeScript and ESLint passed. Rebuilt and visually inspected the local implemented-component preview; no remote Git operations or formal deployment performed.

## Original-template revision

- [x] Remove section 4/6/7 decision columns and section 5 decision links; retain the existing rule overview and unchanged trace inputs.
- [x] Restore template table layout, fonts, padding and scroll containment; remove card/feature typography and sizing overrides.
- [x] Retain ASIN labels, visual truncation and in-place full-text expansion without rewriting report content.
- [x] Rebuild the local preview from the original navigation JSX, SVG icons and compiled application styles, without editing application navigation.
- [x] Verify final preview and regression checks; no remote push or formal deployment.

Original-template validation: seven regression tests, ESLint and TypeScript passed. Browser inspection confirmed eight original navigation menus with SVG icons and section 4/6/7 column counts of 7/5/6. The local sample-data preview is available on port 31913; production was not deployed and no remote Git operation was performed.
