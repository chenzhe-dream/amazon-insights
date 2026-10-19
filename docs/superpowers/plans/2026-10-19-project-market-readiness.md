# Project and marketplace readiness and UK darts report

Goal: honour the approved project + marketplace + exact seven-ASIN boundary, collect an independent UK report, and verify it on port 31900.

- [ ] Regression: a UK project must not count US/shared ASIN caches; mismatched project/site/ASIN requests fail closed.
- [ ] Read readiness from the current project's published job, validate organization, project, marketplace and exact cohort. Pass scope from both browser callers and discard stale responses on scope changes.
- [ ] Give non-US collection jobs an organization/project/marketplace cache directory without seeding US data. Preserve existing US reports and caches.
- [ ] Run targeted route/cache/worker tests and typecheck. Publish through the managed idle/preflight gate.
- [ ] Start one UK analysis for B0FJ4T6V2C, B0F5NRLWB6, B0C6FP6LMY, B0FPXDD2D4, B0DQCF6ZVZ, B0DLB22T15, B0GHQW7GYY. Retain real provider gaps.
- [ ] Verify published project identity, data provenance, and browser matrix on 31900. Do not restore the cancelled D: monitor.
