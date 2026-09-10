# VOC Module Organization Plan

Continuation of the approved incremental module organization. Baseline: `5e5e1ee`.

Move thirteen frontend VOC source/style files into `app/features/voc/`, covering manual import, tutorial, local state, display schema, summaries, positioning and evidence presentation. Preserve all behavior and resolved dependencies. Shared clients, generated data, report helpers and backend implementation remain at their current paths.

- [x] Move files and update source imports, test file references and configuration paths.
- [x] Verify normalized source equivalence and stale references.
- [x] Run relevant VOC unit/browser tests, build and rendered HTML checks; compare type diagnostics against baseline where needed.
- [x] Independently review, document actual boundaries and commit locally.

No GitHub push or deployment. Production remains the already published VOC fix. Preserve existing untracked evidence. Existing test/type debt must be reported separately, without weakening assertions.
