# Variant/category plan report

Status: DONE

- Baseline: `2975059`
- Inputs reviewed: approved VOC gap inventory, runner, Sorftime variant/category builders, package scripts, category retry/resume tests, postcondition tests, bounded diagnostic schema, category readiness/projection consumers.
- Deliverables: design spec plus implementation plan with exactly two independent P0 tasks.
- Task 1: Sorftime variant command contract uses the existing `variant:sorftime:sync` builder while retaining Sorftime connector, `child_sales` stage and `SORFTIME_ASINS` scope.
- Task 2: category collector settles failures per ASIN/node, retains successful cohort members, writes existing error/empty record shapes with fixed reasons, emits bounded per-ASIN diagnostics, and aggregates CLI exit status for the existing sync postcondition.
- Gates: focused fake tests, changed-file lint, one final production build, scope/WIP check and independent spec/code-quality review.
- Exclusions preserved: no real Provider/POST, deployment, push, restart, generated-data write, credential access, MCP adapter change, node inference, catalog-text trend fabrication or architecture extension.
- Conflicts: none. Existing `.superpowers/sdd/*` WIP was not modified or staged except for this requested report.
