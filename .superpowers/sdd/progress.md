# Alexa VOC normalization SDD progress

- Base: `edf9df97c4189fab467cb4215b5a597459e673d9`
- Branch: `codex/feat-alexa-voc-normalization-20260901`
- Design: `9295772`
- Plan: `bd7e652`

| Task | Status | Commit | Evidence |
| --- | --- | --- | --- |
| 1. Runtime skills, strict contracts, stage/snapshot migration | complete; independent review PASS | `9c5450bf28b5eccfcd4a08841dd5423f0cb3ff6f` + `b41c7242a4d505a8fb8e1f34160c2bbc5a76f6ac` | RED captured; focused 59/59; SQLite repository 22/22; review regressions 110/110; skills validation/build/diff-check PASS; PG integration deferred until Docker is available |
| 2. Authorized fast path and encrypted fallback snapshot | complete | `568f7b2` | independent review clean |
| 3. Per-ASIN audited worker and insight/report compatibility | complete | this commit | RED/GREEN captured; core 31/31; manual SQLite 19/19; repository 22/22; skill-runner affected 51/51; build/lint/diff-check PASS; PG Docker integration deferred |
| 4. Per-ASIN polling, isolation, final gates | complete; backend authority repairs complete | `486074d` + `4e71e5b` + second repair (this commit) | original affected 111/111; second repair affected 133/133; composite migration/retry/cutoff regressions PASS; changed lint 0 errors; Task4 tsc 0 errors; OpenSpec 7/7; diff-check PASS; prior build PASS; PG Docker integration deferred |

Guardrails: latest `C:\Users\EDY\Desktop\alexa-for-shopping-voc\` only; no old `voc-listing-optimizer`; no push/deploy/restart/real provider POST; preserve unrelated worktrees and runtime data.

## VOC input data gaps planning

- Base: `5ac4b7a016ac7ea6c69c1d13eead7e20062365d4`
- Branch: `codex/fix-voc-input-data-gaps-20260902`
- Design: `docs/superpowers/specs/2026-09-02-voc-input-data-gaps-design.md`
- Plan: `docs/superpowers/plans/2026-09-02-voc-input-data-gaps.md`
- Status: plan created; implementation tasks have not started.
- Scope: two P0 implementation tasks (Alexa identity/error classification; Sorftime zero-cache/UI truth) plus one read-only evidence inventory gate.
- Guardrails: no real Provider, deploy, push, restart, real POST, generated-data edits, architecture expansion, or speculative B074 adapter.

## Sync publication and data quality repair

- Base: `377efad7ead57ff40904952a6268210f1aae099c`
- Plan: `docs/superpowers/plans/2026-09-02-sync-publication-data-quality.md`
- Task 1: complete (`3b5b291..9fd32af`, review clean)
- Task 2: complete (`9fd32af..06922ae`, review clean after Important repair)
- Task 3: complete (`06922ae..a3120b7`, review clean after Important repair)
- Task 4: complete (`806822c`, final review PASS) — focused 64/64, production build, and BASE-to-HEAD diff-check PASS; PostgreSQL integration blocked by unavailable Docker API; changed-source ESLint retains the known `app/page.tsx` baseline hooks/ref findings.

## 2026-09-06 西柚展示语义微调

- Branch: `codex/fix-xydc-status-order-20260906`; baseline `1eb1d4e`; approved design/plan `8d71943`.
- Task 1: complete (`8d71943..939a4cc`); independent spec/quality Approved and whole-branch Ready to merge Yes; no Critical/Important.
- Baseline: XiYou UI 14/14; isolated runtime data contract 10/10 with `--conditions=react-server`.
- Scope: distinguish catalog/variant status, input-aligned family order, Chinese reasons and separate source/fetch timestamps. No live/provider/data changes.
- Final verification: UI 18/18, runtime-data 10/10, new-build HTML 3/3, targeted lint/build/diff-check PASS; source fingerprint matches; desktop/mobile/drawer fixture images inspected.
- Minor deferred: add explicit unmatched-groups ordering test; implementation reviewed correct. Evidence: `docs/verification/2026-09-06-xydc-status-order.md`. Not merged or deployed.

## 2026-09-07 VOC import status repair

- Base: d9d9d6e; branch codex/fix-voc-import-status-20260907.
- Design/plan: docs/superpowers/specs/2026-09-07-voc-import-status-design.md; docs/superpowers/plans/2026-09-07-voc-import-status.md.
- Baseline: client store/import-feedback/status 32/32 pass; Docker available.
- Task 1: complete (57620ca..94f4534, independent final re-review Approved, no Critical/Important). Root fresh client/helper/mounted-browser combined 58/58 pass; stale-scope test forces valid late response delivery and prevents old callback/application. Screenshot is behavior-only, not production styling evidence.
- Task 2: complete (9dfeafd..47ebdba, independent re-review Approved, no Critical/Important). Real-PG and SQLite store suites 45/45, targeted migration tests 3/3. Exact publication cause: empty legacy negatives allowed by shared schema but rejected by PG trigger 0020; forward 0027 now proven with actual pre-upgrade schema and cumulative legacy/new sibling data.
- Task 2 Minor for final review: claim-eligibility predicate duplication between queue/status and PG/SQLite may drift with future worker-rule changes; currently consistent and behaviorally tested, no broad refactor performed.
- Extended baseline: root ran 132 server tests, 128 pass / 4 fail. All four old semantic-conflict assertions also fail on unchanged d9d9d6e; migration 0023 added content_hash to VOC snapshot identity (08599a7). OpenSpec agreed to report these separately without expanding this repair into old test maintenance.
- Task 3: final backend 130/134 (same four baseline failures), client 58/58, existing app browser 10/10, new-build tutorial 7/7, production build/fingerprint and changed-file lint PASS. Test-only callback typing correction de67e4c reran mounted tests 4/4 and targeted lint PASS. Fresh coordinator compiler diagnostics at de67e4c show only the pre-existing test TS2353 in affected files; full-project TypeScript remains non-green.
- Whole-branch review: d9d9d6e..de67e4c Approved, no Critical/Important; repeated eligibility predicates retained as a non-blocking Minor. Final evidence: docs/verification/2026-09-07-voc-import-status.md. Source stays locked; handoff to OpenSpec for joint review, not unilateral merge/release.
- Guardrails: isolated worktree/tests only, no production writes/replay/provider/restart/deploy/push.
