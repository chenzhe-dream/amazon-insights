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

## 2026-09-07 Code-only publication entry

- User explicitly confirmed the minimal entry design after the 17-commit VOC integration and 214 scoped integration tests. Formal update/restart is separately already authorized, contingent on guards and verified code activation.
- Implementation base bd7d783; isolated existing worktree fix-voc-import-status-20260907 reused on new branch codex/feat-code-only-publication-20260907. Original VOC branch preserved. Target integration remains14111df with15 generated dirty files; do not edit it during implementation.
- Design/plan: docs/superpowers/specs/2026-09-07-code-only-publication-design.md; docs/superpowers/plans/2026-09-07-code-only-publication.md.
- Fresh publication baseline: artifact/control/request/supervisor 95/95 (30923.7492 ms), no skips/cancellations. Main/GitHub/formal runtime unchanged.
- Task1: complete (commits 011ca46..9737940, review clean). Independent spec compliant / Task quality Approved; no Critical/Important. Minor: successful prepare-CLI exit/prune/new-CLI-submit could gain a dedicated process-level test; lease lifetime and function-level persistence coverage verified correct. Root fresh script132/132 + health16/16 + built-browser7/7, build/fingerprint, 15-file lint and branch diff-check passed. Whole-branch review and formal activation remain separate gates.
- Whole-branch bd7d783..deab0aa Ready to merge Yes, no Critical/Important. Target-only FF to deab0aa completed; fresh target132/132 +16/16 + final7/7, build/fingerprint passed. Initial browser navigation timeout and focused/serial replay are disclosed in the release evidence. Changed TS diagnostics0; whole-repo341 remains separate debt.
- User-authorized manager -PublishCode completed: actual code artifact043a0f07, source47d0235c, Agent/manifest commitdeab0aa all match; real dataCurrent/streams and15generated hashes unchanged. Normal0027 migration applied; PG healthy, active0/ownedtrue, no3000, no business replay/Provider/main/push. Final OpenSpec joint check pending; details in docs/verification/2026-09-07-code-only-formal-release.md.
- Final OpenSpec joint gate: Approved, no blockers. Independently verified actual health/source/dist/immutable identity, exact normalized request/ack, retained provenance/streams,15hashes, canonical roots/ownership/ports, read-only DB counts/all27migration checksums/bounds and backup size/hash. It did not rerun suites or perform real business/Provider/restore/second-computer tests. Task and authorized local release complete; final source commit is documentation-only, target/formal remain deab0aa.

## 2026-09-08 Xiyou twelve-month parent orders

- Branch: `codex/feat-xydc-parent-orders-12m-20260908`; user requested a Git checkpoint before development.
- Pre-development checkpoint `c7c8875`: approved static image + design + targeted baseline record. Existing tracked source unchanged, no push/formal modifications.
- Plan: `docs/superpowers/plans/2026-09-08-xydc-parent-orders-12m.md`.
- Baseline: UI normal React 18/18; service/client/cache react-server 43/43. Mixed React conditions produce Windows ENAMETOOLONG in four old fixture spawns; separate normal commands all pass without edits.
- Task 1: complete (commits `1405329`..`1724d93`, review clean). Spec compliant / Task quality Approved; no Critical/Important. Implementer focused11/11 + existing26/26, targeted ES2017 TypeScript and ESLint clean; root freshly reran focused11/11. Collector/cache/auth/UI cross-task checks remain Task2/3 and final-review gates.
- Task1 Minor for final review: unnamed invalid-schema candidate loop at tests/scripts/xydc-order-summary.test.ts:103-154 could use descriptive assertion messages for diagnostics.
- Task 2: implemented at `f2f77e2`, base `1724d93`, NOT complete. Root locked six-file suite70/70, but root offline cache probe and independent reviewer confirm Important stale/expired/future cache freshness laundering plus ASIN-only cross-country reuse. Await full review then one fix agent / re-review. Reproduction .superpowers/sdd/xydc-orders-cache-probe.ts; full report .superpowers/sdd/xydc-orders-task-2-report.md. Task 3: pending.
- Optional user question outstanding: show same-window data older than24h as explicitly stale on refresh failure, or hide. Reviewer regards current runtime age exclusion as compatible with task brief; no change to that choice without resolving against the user response.
- Task2 fix wave running: fresh implementer xydc_orders_collection_fix addresses freshness/country plus reviewer-confirmed runtime merged-parent union lookup and child-timestamp validation gaps. Updated fix brief authorizes five scoped source/test files; keep old variants contract and optional stale-display question separate. Root union repro storedChildCount2/returnedOrderFamilies0 confirms missing handoff.
- Task 2: complete (commits `1724d93`..`b211b21`, review clean). Independent re-review Spec compliant / Approved, no remaining Critical/Important/Minor. Root locked77/77 plus all3 actual temporary-cache probes passed; core postconditions22/22 separately passed. Runtime >24h hide policy unchanged pending optional user preference.
- Task 3: in progress, base `b211b21`, annual cards and per-parent dialog. Root will correct initial truncated TypeScript baseline count:313 was observable diagnostics in truncated output, not a reliable full count; current full log341.
- TypeScript baseline correction verified: root read-only CompilerHost Git overlay at checkpoint c7c8875 gives341 diagnostics, current b211b21 also341; canonical per-file/code/full-message hash multiset identical (added0/removed0). Initial313 was truncated output. Script .superpowers/sdd/xydc-ts-baseline.mjs; no worktree/source/output mutations.
- Guardrails: no live Provider, shared data/generated files, formal restart/deploy, main/GitHub or parallel-worktree edits. All snapshots are test-only until separately authorized live use.
- Task 3 initial commit5309104: root UI11/11, server77/77, build/source fingerprint pass; TypeScript341 unchanged and page lint10errors/7warnings unchanged. Independent review Needs fixes: pending variant metadata hidden, matched inputASIN absent, child/variant-cache states lost, 4percent/minpx chart distortion, missing accessible monthly data equivalent, removed/readded parent auto-reopens. One fresh fix agent receives the complete six-item batch in xydc-orders-task-3-fix-brief.md; Task3 not complete.
- Task3 Minor roll-up for final review: 10-11px readability; repeating8color palette; independent SSR/client clock crossing UTCmonth. Task1 unnamed invalid-schema test-loop diagnostic Minor also remains recorded.
- Task3 correction4fef34e: root UI13/13, TypeScript341 unchanged. Independent re-review cleared five items but keeps lifecycle Important: model reference equality closes dialog when real page's inline products array changes on every parent render. Same fix owner is correcting only the remaining lifecycle issue with equivalent-new-props/current-data/remove-readd regressions; no build or readiness claim for4fef34e.
- Task 3: complete at `2de23bd` after lifecycle correction; independent Spec compliant / Task quality Approved, all six Important findings closed. Stable selection resolves current data and guarded committed-absence cleanup protects newer selections. Root fresh UI13/13, server77/77, build/lint/diff check pass; TypeScript341 fingerprints unchanged. Whole-branch review remains pending.
- Whole-branch final gate `3ccc0ef..2de23bd`: Ready to merge Yes (technical approval), no confirmed Critical/Important. Four known Minors explicitly retained as nonblocking: unnamed invalid-schema loop, small typography, repeated palette beyond8children, narrow UTC SSR/hydration boundary. Candidate Windows cancellation finding withdrawn after an offline process/socket/PID probe disproved orphaning on current Node24.14.0; actual npm/order-CLI and other-platform cancellation remain pre-activation verification, not proven here. Root fresh112 distinct targeted tests pass (UI13+server77+core22), isolated build and source/dist fingerprint match, lint baseline exceptions and341 existing TS diagnostics documented. Formaldeab0aa and15generated hashes unchanged. Implementation complete locally; no merge/push/formal/live-provider actions. Final evidence: docs/verification/2026-09-08-xydc-parent-orders-12m.md.

## 2026-09-08 Xiyou hover and collection resilience follow-up

- Current status: SCOPE CONFIRMED / CLEANUP ONLY. User confirmed XYDC-ANNUAL-V2 and requested correction/removal of mistakenly added monthly work, rollback only if needed. This cleanup does not resume the revoked implementation task or start new feature work.
- Follow-up base `9f44f9c`; current isolated worktree and branch retained. Plan-only commit `f210013afc760f45cd8779b6f67ad615ee903978` contains the superseded scope, not current implementation authority. Formal service, shared data and parallel worktrees remain out of scope.
- Current design `docs/superpowers/specs/2026-09-08-xydc-hover-and-collection-resilience-design.md` replaces old mixed monthly/annual text with K1 preserved baseline, confirmed A1/A2/B1/B2, excluded D1/D2 and separate publication gate X1. Confirmed feature work remains unimplemented.
- Old plan `docs/superpowers/plans/2026-09-08-xydc-hover-details.md` and `.superpowers/sdd/xydc-hover-task-1-brief.md` are REVOKED and contain no executable Task heading/body. Old instructions remain recoverable in Git f210013. B plan has not been written; no B task has been dispatched.
- Baseline: server67/67 passes with react-server condition; UI6/7 fails immediate updated-parent assertion at old line395. Diagnose React scheduling race vs real stale model; preserve expected updated brand/count. Earlier mixed-conditions import failure is command misuse, not a product regression.
- A Task1 STOPPED BEFORE SOURCE EDITS; never resume its old brief. Current scope is confirmed; fresh tasks require new aligned plans and each independently extracted brief must embed scope version/allowed IDs/excluded IDs/file ownership/production guards.
- Guards: no live Provider, shared generated/data/cache edits, main/GitHub, formal restart/activation or parallel-worktree mutation; preserve untracked test-results. Old completed SDD tasks above remain complete.
- Read-only integration reconnaissance completed, not implemented. Important clarification for future B design: canonical traffic analysis run may settle while sync job continues; use actual job lease/generation and explicit run cancellation, not every analysis run terminal as a cancel event. Current authority remains paused.
- Scope-change process: latest user exclusions override old documents; root invalidates affected plan/brief/current status together, checks intended diff against approved IDs before dispatch and commit, and asks before expanding scope. Cross-review checks these boundaries independently. These are workflow gates, not a promise of zero possible human/agent error.
- Cleanup evidence: `git diff --exit-code 8f140346d4caa4e03e3a5dd761dfc751d7720f2f -- . ':(exclude)docs/**' ':(exclude).superpowers/**'` exits0; no non-test-results untracked source. Therefore no source rollback needed. Old monthly task bodies removed, revoked markers retained, old text recoverable in Git f210013. Save a forward local docs-only correction; do not rewrite history or delete existing12month implementation/test-results.
