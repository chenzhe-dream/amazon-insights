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

## 2026-09-07 VOC multi-ASIN recovery follow-up

- User approved minimal design and execution. Base 23f9f4a; branch codex/fix-voc-multi-asin-recovery-20260907; original branch remains locked at base.
- Design/plan: docs/superpowers/specs/2026-09-07-voc-multi-asin-recovery-design.md; docs/superpowers/plans/2026-09-07-voc-multi-asin-recovery.md.
- Baseline focused normalization/attempts/SQLite/PG-unit tests: 34/34 pass, expected Node experimental SQLite warning.
- Evidence correction: prior multi-audit review fixture manually injected failure and only compared the base queue SELECT, not a complete base/natural-path run.
- Task 1: complete at 215f71f (implementation eed1f3d plus terminal provenance review fix). Natural real-runtime/fenced-repository RED reproduced the multi-audit failure in both adapters before GREEN. Per-input recovery is normalization-only; other stages retain their single-audit behavior.
- Root extended pre-edit baseline: PostgreSQL jobs + generic worker + agent-run repository 55/60; five existing agent-run contract failures recorded in docs/verification/2026-09-07-voc-multi-asin-recovery.md. No production-source changes had been made; keep these separate from repair regressions.
- Fresh final verification at locked code HEAD 215f71f: eight-file scoped suite 115/115; production build, changed-file ESLint and diff-check PASS; source/dist fingerprint 6450c27e60a8ecb88e8e34df5f6ac5a3e098cf5a1a7c2b2cfb18763fe87539bc matches. Exact changed-file TypeScript diagnostics zero; whole-project count remains 343. The separately observed service baseline failure makes six pre-edit audit-contract failures, not failures within the scoped 115.
- Independent task re-review: spec compliant and Approved; Important terminal provenance issue cleared while preserving legal cross-project/run historical success. Whole-branch 23f9f4a..215f71f Ready to merge Yes, no Critical/Important. Newly exposed PostgreSQL concurrent-query warning in unchanged audit mapping remains a documented non-blocking Minor, not a proven baseline warning.
- Evidence: docs/verification/2026-09-07-voc-multi-asin-recovery.md and the implementation task report. Cancellation is audit-seeded; expiry is real lease expiry without process-kill coverage. Source locked for read-only OpenSpec joint review; formal runtime has not been switched.
- Joint-review gate reopened at handoff 5bc0bb4: one Important, A's completed permanent failure is re-executed when transient sibling B advances the automatic retry to a new logical cycle. OpenSpec natural two-adapter reproduction observes A=2/B=4 versus required A=1/B=4 despite the original 115 remaining green. Sole-implementer minimal fix plus explicit-retry positive coverage is required; integration remains blocked. Brief: .superpowers/sdd/voc-recovery-sibling-fix-brief.md.
- Joint-review correction implemented at 45c1d7d: runtime/reducer retain completed terminals only within the same trusted automatic retry chain; explicit same-input enqueue begins a new chain and can execute again. Formal RED 0/2 and GREEN 2/2 plus explicit retry proved; implementer covering 63/63. Coordinator fresh full scoped suite 117/117, build/lint/diff PASS, exact changed TypeScript diagnostics 0/global343; source/dist fingerprint 65585e96660f932000d940926bbb5496c2ea9df7f887e58695c30f7734ad7020. Independent re-review and OpenSpec acceptance pending; no formal activation.
- Independent re-review at 45c1d7d: spec compliant, task quality Approved; whole-branch 23f9f4a..45c1d7d Ready to merge Yes, no Critical/Important. Existing PG warning remains Minor. Source locked for OpenSpec joint re-review; final coordinator documentation commit waits for that verdict. No merge/release activation.
- Final OpenSpec joint gate: Approved at locked code45c1d7d; completed-permanent-sibling Important cleared, no new Critical/Important. OpenSpec freshly reran focused SQLite/isolated-PG cases 2/2 (duration_ms7623.6322), checked runtime/reducer retry-chain bounds and explicit enqueue preservation, recomputed matching65585e96660f932000d940926bbb5496c2ea9df7f887e58695c30f7734ad7020 fingerprint and diff check. Task complete; final commit updates only coordinator evidence/progress. No formal switch, merge, push, restart, deployment, historical replay or live-provider use.
- Guardrails unchanged: isolated tests, no live providers or formal-state changes, preserve history and parallel integration edits.
