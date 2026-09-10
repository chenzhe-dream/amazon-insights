# Complete page decomposition with rollback checkpoints

User authorizes continuing all batches without repeated prompts, with rollback safeguards. Starting commit: `0fcc192`, tag `checkpoint/before-page-decomposition-20260910`. Do not deploy or push GitHub. Preserve existing untracked evidence and user changes.

Acceptance: app/page.tsx is a route/authentication entry; presentation lives in cohesive feature components; workspace side effects and state live in named controller hooks; the composed application is readable rather than moving the entire monolith unchanged. Preserve hook ordering, event identity, scopes, cache and API behavior. Keep generated files unmoved. Avoid artificial splitting of tightly coupled statements just to meet line counts.

1. Extract top-level display components, chart helpers and shared product/market contracts from page into owning modules. Verify equivalent bodies/import targets, relevant render/browser tests and type baseline. Commit and tag a passing checkpoint.
2. Extract inline tab sections and application frame as presentation with explicit typed inputs. Preserve all JSX and callbacks. Verify browser paths, commit checkpoint.
3. Separate workspace controller/state/effects from presentation into cohesive hooks using existing boundaries (runtime data, project/navigation, saved reports and analysis status). Preserve effects/dependency arrays and ordering; verify scope/concurrency/history flows. Keep a modest composition controller where state genuinely coordinates features.
4. Make page a thin auth/route entry, update callers and source-location checks without weakening assertions, run final focused suite/build/import/type comparisons and independent review. Record known baseline failures separately.

Every batch starts from a committed checkpoint; repair or revert only that batch if it introduces regressions. Never reset unrelated files, delete runtime data or publish unverified refactors. A failed broad preexisting assertion is not permission to suppress it. Browser suites run sequentially because default Vite caches conflict.

Completed stages 1–4: standalone components, all inline tabs/frame, cohesive controller hooks/actions and final verification. Route entry18lines; workspace view94lines; composition controller310lines; 22 leaf modules, largest231lines. The accepted dependency adjustment adds only independently proven stable React setters/ref objects, preserving existing dependency order and runtime effect behavior. Final checkpoint and all evidence are recorded in docs/verification/2026-09-10-page-decomposition.md.
