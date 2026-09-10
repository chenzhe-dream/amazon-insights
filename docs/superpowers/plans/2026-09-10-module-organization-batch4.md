# Keyword and traffic module organization

Continue the approved behavior-preserving organization from `462afd2`.

- Move eight frontend files into `app/features/keywords/`: keyword-demand-analysis.ts, keyword-classifier.ts, keyword-non-english.ts, keyword-demand-section.tsx, keyword-meaning-taxonomy.ts, keyword-demand-conclusions.ts, keyword-fetch-status.tsx and sif-keyword-field-glossary.ts.
- Move three frontend files into `app/features/traffic/`: traffic-fetch-status.tsx, traffic-detail-recovery.tsx and traffic-analysis-conclusion.ts.
- Rewrite imports and executable test/config paths to the same resolved targets. Update current navigation documentation and active skill pointers where appropriate.
- Preserve generated data files, shared clients, backend behavior, public URLs and assertions. Do not deploy or push GitHub; preserve untracked evidence.
- Use a bounded implementation subagent and independent review while the root verifies tests/build/types. Compare normalized sources and diagnostics against baseline; document preexisting failures separately. Commit locally after verification.

Completed: all moves and references verified, 60 post-migration targeted checks passed, build passed, no added type/lint diagnostics, independent review Ready. See `docs/verification/2026-09-10-module-organization-batch4.md` for the interrupted parallel browser run and successful sequential rerun.
