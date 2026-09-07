# VOC multi-ASIN durable recovery

User approved the minimal repair and authorized implementation on 2026-09-07.

## Baseline and evidence

Base: `23f9f4a3cb24896e94c94cba0108301c8c1250b4`. Preserve branch `codex/fix-voc-import-status-20260907` at that commit. Implement on `codex/fix-voc-multi-asin-recovery-20260907` in the existing isolated worktree.

Migration 0023 makes an audited run unique by stage, logical cycle and execution fingerprint. The normalization handler processes multiple snapshots in one stage/cycle. PostgreSQL and SQLite durable-cycle recovery still reject more than one audited run; both failure settlement and expired/retry claim use that check.

The earlier review fixture manually forced a failed-at-limit job. It proved the current multiple-row rejection and that the old queue SELECT also reused that job. It did not execute the complete baseline or a natural failure/recovery cycle. This repair must first reproduce the natural path with real repositories, audited execution, a fake provider and a controlled cumulative-publication failure.

## Behavior

1. Scope batch recovery to `alexa-voc-normalization`. Preserve the single-audit contract and outcomes for every other stage.
2. Match every recovery item to its organization/project/run/stage, snapshot and execution fingerprint. Different legitimate fingerprints may coexist; arbitrary first/latest rows must never authorize another input. Retain duplicate/malformed identity rejection.
3. Keep completed input terminals and revisions. Recover an already successful durable normalization without a new model invocation; repair only its missing publication/terminal, idempotently.
4. Truly unfinished inputs obey existing execution retry, cancellation and model-budget rules. A successful sibling cannot authorize extra model calls after these limits. Pending audit evidence is not synonymous with successful normalization or permission for an unbounded fresh execution.
5. Decide job recovery from the relevant per-input states, not `some successful audit`. Mixed success, absent audit, pending audit and permanent failure must remain distinct. Missing or exhausted results must not remain permanently pending or be reported as success solely because another input completed.
6. PostgreSQL and SQLite failure settlement, retry/expired-lease claims, queue reuse and status responses must agree. Retain lease fencing, retry backoff and bounded publication attempts. State must converge after recovery and after retry exhaustion.
7. Do not split every ASIN into a new job, change database schema, change the UI, remove audit history, clear data or relax global limits for this repair.

## Acceptance

- Natural multi-input path: A and B execute in the same cycle through the normalization handler/service and audited fake provider. A publishes; B obtains a durable revision, then its cumulative snapshot publication throws. The real worker invokes `failJob`, and a later real claim recovers. No direct UPDATE to manufacture failed status. Both provider call counts remain one after recovery; B's exact terminal/revision becomes readable; no duplicate revision or cumulative content is created.
- Repeat at the existing execution-attempt limit. Durable-only recovery remains bounded by the existing publication policy and cannot make a fresh provider request for a never-executed sibling.
- Separately exercise worker interruption followed by expired-lease claim and normal failed-job retry. Repeated recovery and late stale-owner settlement cannot duplicate or overwrite results.
- Test mixed inputs (success plus pending/absent/permanent failure), cancel and budget outcomes, duplicate/incorrect fingerprints, and non-normalization single-audit parity.
- Cover real SQLite and isolated PostgreSQL. Tests must fail against the pre-fix code for the expected recovery guard, then pass after the repair. Source-pattern assertions and handcrafted failed records alone are insufficient.

## Safety and delivery

No live Provider calls, formal database access, old-input replay, service restart, artifact activation, merge, push or deployment. In particular do not replay wrong-target snapshot `9ec06711-35cd-42a4-a146-aef1764071cd`. Preserve the separate integration worktree's generated data. Keep prior test-contract and whole-project TypeScript debt separate from new regressions. Deliver a tested locked HEAD and evidence to OpenSpec for joint review, not release activation.
