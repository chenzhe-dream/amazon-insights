## Why
The operator confirmed the supplied original frontend as the visual baseline. The integrated UI exposes implementation workflow panels and changes the original result/report hierarchy. Restore the original frontend presentation while keeping the current backend authoritative.

## What Changes
- Follow-up after original preview review: explicitly separate original presentation, analytical methodology and server integration; restore result-page structure, not only similar CSS. Preserve a traceable inventory of the original analysis dimensions and retained improvements.
- Restore report-first presentation and compact auxiliary controls across the four market modules.
- Restore overview result-row report entry and inline report, original-style KPI groups and report sections.
- Preserve current API endpoints, analysis algorithms, evidence rules, task/revision lifecycles and HTTP-compatible command IDs.

## Capabilities
### New Capabilities
- `market-reference-presentation`: original frontend appearance adapted to current backend facts.
### Modified Capabilities
None.

## Impact
Frontend components, scoped styles, frontend fixtures and tests only. No server/shared contracts, migrations, providers, calculations, or production business data writes during tests.
