# Listing and product-report organization verification

Baseline `5ab880e`. Thirteen files moved: two Listing components, eight product-report/checklist files, and three genuinely shared presentation components. Twelve caller/test/config files follow the same resolved targets. Current README and two active Cursor skill path maps updated. No generated data, API behavior or publication change.

## Evidence

- Independent normalized comparison: 25/25 equivalent (13 moved + 12 callers/configs); zero executable stale paths. Browser fixture template import in listing-images-section.test.tsx follows the new path without changing assertions. Reproduction and evidence: untracked `test-results/move-listing-product-modules.mjs`, `module-batch5-moves.json`, `module-batch5-equivalence.json`.
- Listing image source/hover preview, persisted product definition, keyword/VOC model and legacy characterization: 21/21 before and after. Command: `npx --no-install tsx --test tests/agent/listing-images-section.test.tsx tests/agent/product-definition-section.test.tsx tests/agent/voc-keyword-page-model.test.ts tests/agent/voc-legacy-characterization.test.ts`.
- Evidence browser and saved-report view/export checks: 12/12 (`npx --no-install tsx --test tests/agent/voc-keyword-evidence-browser.test.ts tests/agent/saved-analysis-reports.test.ts`). Browser groups ran sequentially to avoid shared Vite cache interference.
- Evidence gating: 4/4 (`npx --no-install tsx --test tests/agent/voc-keyword-evidence-gating.test.ts`).
- `npm run build`: passed with existing chunk-size/static-route warnings and a plugin-timing notice.
- Built rendering and tenant-data exclusion: 5/5 (`node --test tests/rendered-html.test.mjs tests/manual-alexa-voc-client-bundle.test.mjs`). Total completed post-migration checks: 42.
- Main-page dependency graph plus all thirteen moved TypeScript roots: baseline 26 diagnostics, current 26, zero additions. This scope includes additional report/export roots versus the previous batch, so its baseline count differs. Virtual-baseline script restores old source paths from Git; evidence in untracked `test-results/batch5-typecheck.*`. This is not a claim of a clean repository-wide typecheck.
- ESLint: thirteen files, zero errors, eight warnings before and after; same rule/message/line/basename multiset. All 34 targeted-tsconfig file entries exist.
- Independent read-only review: Ready, no findings; reviewer independently compared all thirteen source bodies/import targets and reviewed all twelve caller/config/test changes. `git diff --check` passed.

## Delivery and remaining scope

Local commit only, no GitHub push or deployment. Web and Agent both returned HTTP 200/status ok; formal Agent still reports `5ba042f05633b56c7cf2a35bd20bf5a91de4a3c3`. Existing untracked artifacts remain preserved. The main frontend business files now have owning directories, but page.tsx still owns state, effects, orchestration and inline presentation. Those require a separate behavioral extraction rather than declaring architecture work complete. Prior unrelated test/type debt is retained.
