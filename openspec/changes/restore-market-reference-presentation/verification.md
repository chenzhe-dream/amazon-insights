# Frontend restoration verification — 2026-09-16

## Scope and authority
Reference frontend: `C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app`. User confirmed frontend reference, current backend authority. No old backend collectors, analysis functions, or provider routes were imported.

Byte comparisons against the pre-UI release source snapshot confirm `server/`, `shared/`, `worker/` and `scripts/` unchanged. UI reads existing backend saved metrics and evidence; missing fields/unknown units remain explicit. HTTP-safe UUID helper is preserved.

## Presentation changes
- Overview: result-row report action launches existing current-backend study/run commands for the selected result scope; inline report; compact task/history controls; shared favorites toolbar no longer occupies an empty full card.
- Overview report: sample/head/new-product KPI groups from saved data; existing distributions and synthesis remain; unsupported head averages unknown. No changes to backend calculations.
- Shape: compact query/taxonomy options and task details; report tables precede verbose source controls; manual draft/revision and historical data behavior preserved. Empty-state site label uses selected site.
- Keyword/theme: compact required query context, restored report spacing/header hierarchy, collapsible manual workflow, saved reports remain visible. Failed keyword steps keep retry controls expanded.

## Verification
- Overview original page recovery/history/polling regression and new result-row scope/read-only reopen test: 2/2.
- New insecure-HTTP submission plus overview static/client, cross-site scope and shared favorites combined run: 21/21.
- Final overview KPI/static, row flow and shared favorites check: 6/6. New KPI assertion preserves known zero and unknown concentration units.
- Shape: 7/7 across reference visuals, sorting/filter/bulk selection, saved revisions, read failures and mobile overflow.
- Keyword/theme: 6/6 browser behavior, 26/26 transport/SSR/UI, 2/2 reference visual cases.
- Recovery review found collapse/reopen and in-flight restoration boundaries; fixed with explicit read-only reopen and pending restoration guard. Test holds restored GET and confirms row click emits no new POST.
- Typecheck passed; strict OpenSpec passed. Scoped ESLint has 12 existing errors versus 13 on the prior snapshot, zero new rule/file/message errors. Do not claim repository lint-clean.
- Early Vite browser run produced development-console forwarding errors; test harness now disables forwardConsole like existing harnesses. Clean rerun passed.

## Visual review and limits
Desktop/mobile screenshots inspected. Overview screenshots: `test-results/market-reference-restored/overview-result-{desktop,mobile}.png`. Shape: `test-results/market-ui-parity/shape-results/`. Keyword: `test-results/market-ui-parity/keyword-results/`. Theme: `test-results/market-ui-parity-20260914/theme-comparison/`.

Reference styling is adapted to actual contracts: keyword query retains required category context (279px vs original251px) and theme retains current analysis settings (222px vs195px). No assertion of pixel-identical UI or full live-provider acceptance. Tests intercept provider traffic; no paid collection was started by this repair.

## Release
Published through formal manager at 2026-09-16T09:13:56.249Z (2026-09-16 17:13:56 Asia/Shanghai). Production build passed and preflight had zero active jobs. Source `024ff692bcfe54ff2bd8587e2c7d72fd00721c12df488eb4a12e9e6e5a6cfb73`; artifact `d836a38c0972ba71c3e55a9b3acd1382c81440522ee816c86bbc619f9c399e6e`; request `7f740dda9b890d5b4e6c2e77ab992a69f14286df0f760c7633fc4920f27bb8b9`. Postflight localhost/LAN web and agent HTTP 200, source hashes and web artifact match, business stage hashes unchanged. Prior pointer/state backed up under `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/market-reference-20260916`. Evidence: `.superpowers/sdd/market-reference-release.log` and `market-reference-release-verification.json`.
