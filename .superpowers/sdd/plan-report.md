# VOC input data gaps plan report

- Status: planning complete; implementation not started.
- Base: `5ac4b7a016ac7ea6c69c1d13eead7e20062365d4`
- Branch: `codex/fix-voc-input-data-gaps-20260902`
- Design: `docs/superpowers/specs/2026-09-02-voc-input-data-gaps-design.md`
- Plan: `docs/superpowers/plans/2026-09-02-voc-input-data-gaps.md`
- Plan tasks: 3 total: 2 P0 implementation tasks and 1 read-only evidence-inventory gate.

## Confirmed implementation scope

1. Alexa: reject explicit trusted-ASIN mismatch before queue/model work with HTTP 422 `ALEXA_VOC_ASIN_MISMATCH`; bind marketplace + trusted ASIN into fingerprint; classify defense-in-depth mismatch as schema, not persistence.
2. Sorftime: invalidate cached ready `0/0` against current positive catalog evidence; reuse ready-empty review output only while current trusted zero-review evidence remains valid; display statusMessage and independent Sorftime-source copy in the UI.

## Held scope

- B074 `product_reviews` is a safe diagnostic `MCP_SCHEMA` at `tool-content`. The retained diagnostic contains no actual response shape, so the plan prohibits adapter or request-shape changes until new trusted evidence exists.
- Every other gap is inventory-only. A proven additional code defect requires a separate reviewed design/plan.

## Verification built into the plan

- TDD RED/GREEN commands for four Alexa suites, two Sorftime script suites, and the existing server-render page suite.
- Local fake Provider fixtures only; verified-zero regression keeps Provider calls at zero.
- Final typecheck, production build, BASE-to-HEAD diff check, and changed-file safety inspection.

## Constraint conflicts

none
