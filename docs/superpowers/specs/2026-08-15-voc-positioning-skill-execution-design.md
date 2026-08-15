# VOC Positioning Skill Execution Design

## Scope

Implement only OpenSpec task 8.3: consume one immutable VOC snapshot and its
public-parser-validated deterministic facts, execute the published
`define-amazon-voc-positioning` Skill through the existing Node runtime, and
persist one immutable, versioned `analysis-result`. This change does not add UI,
HTTP routes, external collection, authentication, PostgreSQL, or browser/React
runtime dependencies.

## Follow-up review correction

Two independent adversarial reviews found that the first implementation was
not production-reachable, treated a physical `JobAttempt` as the logical model
execution identity, and allowed model-authored prose to contradict fixed VOC
decision boundaries. OpenSpec 8.3 therefore remains unchecked until this
correction is verified.

### Correction options

1. **Finalize the generic `AgentRun` and insert the VOC report in one
   transaction.** This closes the first crash gap, but couples the reusable
   audited runner to one domain report and still leaves the worker-completion
   gap. Rejected.
2. **Add a domain outbox/lineage aggregate in migration 0006.** This provides an
   explicit state machine, but adds a second source of truth beside terminal
   `AgentRun` and immutable `analysis_reports`. It is unnecessary persistence
   for the two required recovery points. Rejected unless existing audits prove
   insufficient.
3. **Persist a stable logical execution lineage on `AgentRun`, replay terminal
   output under a new legal job lease, and publish idempotently.** The lineage
   binds run/stage, snapshot id/content hash, facts digest, Skill version and
   content, contracts, provider/model configuration and cutoff, but excludes
   the physical attempt id. A new attempt first proves its current lease and
   exact lineage. It may reuse only a terminal matching predecessor; pending
   predecessors fail closed. Chosen because it preserves the runner, budget
   ledger, claim fencing and immutable report store while closing both gaps.

Migration 0006 adds only a nullable, immutable lineage key and a partial unique
index; old and non-VOC AgentRuns remain attempt-scoped. Publication validates
the current tenant/actor/run/project/stage/job lease and the predecessor's exact
terminal identity. An expired owner cannot publish. Drift in tenant, snapshot,
facts, Skill or model cannot replay. Operational report-store failure after a
paid successful audit is retryable infrastructure; the next legal attempt
recovers before any new budget reservation or provider dispatch.

### Production composition root

The server owns a bounded VOC worker runtime. It loads the Node Skill registry,
constructs the configured provider, static budget policy, `SkillRunner`,
`AuditedSkillRunner`, execution service, trusted prepare function and
`JobAttemptWorkerLoop`. Trusted prepare loads run, project and immutable VOC
snapshot from storage, re-runs the public deterministic parser, and derives
actor/organization/project/cutoff from stored subjects. Job payloads cannot
supply them. Shutdown aborts and awaits the worker with a fixed deadline before
SQLite closes. Missing or partial provider/model/budget configuration fails
closed without claiming a job. Tests inject a complete fake provider only at
the external provider boundary.

### Structured assertions and protected safety matrix

The model output contains no publishable free-form conclusion, action,
checklist, risk, acceptance or validation prose. It selects closed enums and
exact theme/evidence references. Code owns fixed decision boundaries: market
size, sales forecast, profitability and project approval are `not-assessed`;
price, cost, compliance, patent and supply chain are `requires-validation`.
Unknown narrative fields are rejected by the strict schema, including Unicode
digits and synonymous claims; safety does not depend on a keyword blacklist.

Every protected safety theme has a deterministic role derived from its rule,
and P0/P1 roles cannot be weakened. Each protected theme referenced by a
positioning assertion or action must have at least one evidence row matching
that exact `(dimension, themeKey)` and its stored source/ASIN provenance.
Evidence for another reference in the same union cannot substitute for it.

## Considered approaches

### 1. Domain execution service around the audited runner (selected)

Add a small VOC execution service that reloads the trusted snapshot, reparses
the supplied 8.2 facts, constructs the strict model contract, invokes
`AuditedSkillRunner`, and publishes the validated result through a report
repository. The report write is independently idempotent, so a process crash
after AgentRun finalization replays the terminal AgentRun without another model
call and then safely completes report publication.

This reuses provider retry, one-shot format repair, budgets, cancellation,
execution claims, lease fencing, usage accounting, and terminal replay. The
trade-off is a two-step durable commit, handled explicitly by replay-safe report
publication rather than by widening the generic runner transaction.

### 2. Add report hooks to `AuditedSkillRunner`

The generic runner could accept a domain validation and persistence callback and
commit an AgentRun plus report together. This gives one transaction but couples
the reusable runtime to reporting and would broaden the regression surface of
the already-audited runner. It is rejected for 8.3.

### 3. Build a VOC-specific runner or worker path

A dedicated executor could combine preprocessing, provider calls, and report
writes directly. It is rejected because it duplicates the existing audited
runtime and would bypass its retry, budget, cancellation, and fencing rules.

## Architecture

The implementation has three focused units:

1. `voc-positioning-contracts` defines closed Zod input/output contracts and a
   business validator. The validator is parameterized by freshly parsed 8.2
facts and rejects altered deterministic metrics, forged facts, priority or
safety downgrades, invalid evidence relationships, source/ASIN/dimension
crossings, duplicated evidence, and incorrect missing-data coverage.
Theme references use the compound identity `(dimension, themeKey)` because the
same normalized label may legitimately occur in more than one VOC dimension.
2. `VocPositioningExecutionService` reloads the tenant-scoped snapshot,
   validates snapshot integrity, reparses the supplied deterministic facts with
   the public 8.2 parser, verifies snapshot identity, rejects all-missing input
   before provider dispatch, and invokes `AuditedSkillRunner` using the
   published Skill and configured model.
3. `AnalysisReportRepository` publishes or replays one immutable report. Its
   SQLite implementation runs in an immediate transaction and revalidates the
   active actor, tenant, project, run, stage, job lease, execution claim owner
   and generation, AgentRun terminal status, SkillVersion, model, snapshot
   identity, and freshly recomputed facts digest before insertion.

No migration is needed: `analysis_reports` already stores immutable versions,
links each report to one AgentRun, and has update/delete rejection triggers.
Serialization plus an immediate transaction makes the existing-report check and
next-version insert concurrent-safe.

## Identity and replay

The provider execution identity remains the existing audited fingerprint over
run/stage/job attempt, snapshot IDs, Skill ID/version/content hash, model
configuration, input/output contract digests, structured input, and cutoff. The
structured VOC input includes `snapshot.id`, `snapshot.contentHash`, and
`factsDigest`, so every required identity component is bound transitively.

The same job attempt and identity replays the terminal AgentRun and does not call
the provider again. Report publication first searches by AgentRun ID: an exact
match returns the existing immutable version; a mismatch conflicts. A different
job attempt may create a later report version while retaining history. Identity
drift inside one job attempt is a conflict, not silent reuse.

## Model input and output boundary

The model receives only the 8.2 whitelist: snapshot provenance, source
availability, normalized theme facts, deterministic priorities and metrics, and
anonymous evidence metadata. It does not receive cookies, credentials, actor or
tenant identity, database rows, dumps, prompts supplied by users, or full review
text.

The output contract contains a result status, identity echo, coverage echo,
positioning conclusions, theme judgments, prioritized actions, checklists,
validation needs, and fixed VOC limitations. Every important conclusion and
P0/P1 action must cite evidence. Deterministic values are echoed only where the
business validator can require exact equality with 8.2 facts.

All objects are strict and all enums are closed. Structural failure is handled
by the existing single format-repair path. Semantic failure uses the same output
contract refinement and therefore follows the identical repair/failure path.
Ordinary logs contain only the existing hashed/count summaries and fixed error
classification; prompts, model bodies, and VOC text are not logged.

## Missing data

`complete` is allowed only when every required source is available.
`partial` is required when at least one source is partial or unavailable but
some evidence exists. The output must exactly repeat each source status and
missing ASIN set. If all sources/evidence are missing, the service fails closed
before provider dispatch with a stable data-quality error suitable for the
worker's existing waiting-input behavior.

## Test strategy

Tests use real scooter and lighting fixtures to create immutable snapshots and
8.2 facts, plus a fake model provider behind the real Skill loader,
`SkillRunner`, `AuditedSkillRunner`, budget coordinator, Worker loop, and SQLite
repository. RED tests cover successful full and partial reports, malformed and
closed-schema output, deterministic drift and forgery, evidence closure,
priority/safety protection, missing-data boundaries, replay/restart identity,
provider retry/repair/budget/cancel/fencing, immutable history, tenant/actor
transaction races, and ordinary Node import/execute. Each negative test mutates
only the target semantic field after recomputing any outer digest needed to
avoid a stale-hash false positive.

## Self-review

The design contains no placeholders, keeps 8.4/8.5 and deployment concerns out
of scope, does not modify migrations 0001-0005 or generated VOC data, and makes
the replay gap between AgentRun and report publication explicit and recoverable.

## Third review correction: trusted execution cycles

The stable stage-input identity and one logical execution are separate
concepts. Reusing only by stage input poisons automatic retries with a failed
terminal AgentRun and prevents an explicit rerun from producing report version
two. Reusing only successful terminals does not solve pending crash ownership
and still cannot distinguish crash recovery from a new requested execution.

Three approaches were considered:

1. Infer reuse from AgentRun terminal status. This is rejected because a
   retryable failed terminal must be superseded while a succeeded terminal is
   reusable only during recovery, not forever.
2. Add a new execution/outbox aggregate and move provider dispatch and report
   publication behind it. This is precise but duplicates the existing
   JobAttempt, AgentRun, budget ledger and Worker state machines.
3. Persist a repository-authoritative logical execution cycle on JobAttempt
   and include it in the AgentRun lineage. This is selected because the
   repository already owns every transition that distinguishes recovery from
   retry.

Migration 0006 adds a validated `logical_execution_cycle_id` to every
JobAttempt. Initial enqueue, automatic retry after a classified retryable
failure, manual retry and explicit rerun receive a newly generated cycle.
Recovery of an expired running lease inherits the predecessor cycle. Callers
cannot supply a cycle during enqueue; the SQLite repository generates or
inherits it transactionally. A partial unique index permits at most one queued
or running JobAttempt per cycle.

The AgentRun lineage hashes the complete stable execution identity plus the
trusted cycle ID. A succeeded predecessor in the same cycle is replayable. A
pending predecessor may rotate its execution claim to the new recovery
JobAttempt only when the repository proves that JobAttempt is the active lease
for the same run, stage and cycle. The original AgentRun/JobAttempt provenance
remains immutable; a separate active recovery attempt reference supplies claim,
budget and finalize authority. Failed terminals never cross into a new cycle.
Non-retryable failures stop because Worker policy creates no successor; an
explicit later rerun is a new audited cycle.

This transition table is authoritative:

| Predecessor transition | Successor cycle |
| --- | --- |
| queued initial claim | retain job cycle |
| running lease expires | inherit cycle |
| retryable failed attempt | new cycle |
| manual retry after failed stage | new cycle |
| explicit rerun after succeeded stage | new cycle |
| non-retryable failure | no automatic successor |

The same transaction that claims a successor assigns the cycle, preventing two
workers from classifying one retry as recovery. Automatic Worker retry remains
bounded by persisted `max_attempts` and retry-cycle policy. SkillRunner's two
transient retries remain inside one physical JobAttempt; JobAttempt retry starts
a new cycle and therefore a new AgentRun and a new set of provider requests.

## Third review correction: positioning stance matrix

Positioning stances and strategies form a closed semantic matrix. A
`supported-by-voc` stance may use only retain, redesign or avoid. A
`requires-validation` stance may use differentiate or validate, while
`not-assessed` uses only validate. `price-tier` is stricter: it always uses
`requires-validation` plus validate because VOC cannot establish price
economics. Competitor imitation is not a member of the closed strategy enum and
is structurally rejected. Hero-upgrade and new-scenario proposals are expressed
as differentiate rather than as positioning dimensions, so the matrix forces
them into `requires-validation`. The other dimensions may be supported by cited
VOC or explicitly not assessed. Safety/P0 references remain avoid/redesign when
asserted as supported, while a validation assertion may safely use validate
without weakening the protected theme.

The matrix is semantic validation over closed enums, not keyword filtering.
The fixed price decision boundary and `price-tier` positioning can therefore no
longer contradict one another in either full or partial output.

## Third review correction: optional provider capability

The Agent Service API and SQLite repository start independently of the optional
VOC model Worker. A testable service composition root opens storage and builds
the API first, classifies VOC runtime configuration, and starts the Worker only
for a complete valid configuration. Missing required fields produce a fixed
`incomplete` capability state; complete but invalid values produce a fixed
`invalid` state. Neither state logs or returns environment values, and neither
claims VOC jobs. Health, capabilities and other API functions remain online.

Every required environment value is checked for undefined or blank text before
numeric conversion. Integer fields accept canonical decimal safe integers only;
prices accept canonical non-negative decimal text and permit explicit `"0"`;
jitter accepts a finite canonical decimal in `[0,1]`. Scientific notation,
NaN, Infinity, negatives, unsafe integers and accounting combinations that
overflow safe integer cost micros are invalid. There are no Boolean VOC runtime
fields. A fully configured runtime may inject a fake provider in tests; the
production path constructs OpenAI only after configuration is valid.

## Third review correction tests

File-backed SQLite and real WorkerLoop tests distinguish provider calls inside
one SkillRunner attempt from calls across JobAttempts. They cover exhausted
transient calls followed by automatic success, bounded physical exhaustion,
manual retry and succeeded-stage rerun producing immutable report version two,
both crash gaps preserving one cycle/provider/report, pending claim recovery,
and concurrent workers. Separate full and partial output mutations cover the
stance matrix. Formal service-entry tests listen on an ephemeral port with
missing, invalid and complete fake-provider configuration and verify health,
capabilities, queued-job non-claiming, execution and bounded shutdown.
