# Listing and product-report organization

Continue approved mechanical organization from `5ab880e`. Move listing-images-section.tsx and listing-aplus-section.tsx into app/features/listing/. Move product-launch-recommendation.tsx, product-launch-analysis.ts, product-definition-section.tsx, final-product-definition.ts, launch-checklist.ts, launch-checklist-template.ts, launch-checklist-section.tsx and launch-checklist-export.ts into app/features/product-reports/. Move shared launch-section.tsx, action-steps-cell.tsx and segment-stack-bar.tsx into app/components/ because existing callers span business modules.

Preserve resolved dependencies, UI behavior, data generation paths, API contracts and tests' assertions. Update executable/config/source-read paths and current navigation/skill docs. No generated data moves, GitHub push or deployment. Preserve untracked evidence.

Use bounded implementation and independent review under the existing subagent workflow. Root verifies source equivalence, relevant unit/browser tests, build/render checks and baseline type/lint diagnostics. Run browser suites sequentially because they share default Vite caches. Record results and commit locally after checks.

Completed: all thirteen moves and twelve callers/configs equivalent, 42 post-migration checks passed, build passed, no new type/lint diagnostics, independent review Ready. Verification recorded in docs/verification/2026-09-10-module-organization-batch5.md.
