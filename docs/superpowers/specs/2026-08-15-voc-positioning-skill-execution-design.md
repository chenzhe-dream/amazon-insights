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

## Fourth review correction: durable cycle disposition

The previous transition table classified a successor only from JobAttempt
status. That is insufficient in three crash windows: a retryable AgentRun may
already be terminal while its JobAttempt is still running; a successful
AgentRun may need report-only recovery after Worker failure handling; and a
successful final physical attempt may need publication or completion recovery
after the numeric attempt limit is reached.

Three approaches were evaluated:

1. Atomically finalize every AgentRun with its domain report. This would make
   the generic audited runner depend on VOC persistence and would still leave
   the report-to-JobAttempt-completion gap. Rejected.
2. Let the Worker or service mark errors as `report-only`. This makes recovery
   depend on an exception type or caller assertion and cannot safely resolve a
   commit-success/response-failure ambiguity. Rejected.
3. In the repository claim/failure transaction, classify the current logical
   cycle from durable AgentRun terminal metadata and report existence. This is
   selected. The repository already owns the trusted cycle and lease state, and
   immutable AgentRun/report rows are the authoritative facts.

The resulting disposition table is:

| Durable same-cycle state | Repository action |
| --- | --- |
| no AgentRun | recover below the physical limit; settle if the final lease expires unstarted |
| pending AgentRun | recover the same cycle, including at the physical limit |
| passed/succeeded, report absent | recover the same cycle in report-only mode |
| passed/succeeded, exact report present | recover the same cycle to complete the JobAttempt |
| failed with `upstream-temporary` or `rate-limit` | create a new cycle if a physical attempt remains; otherwise settle exhausted |
| budget-exceeded | settle stage `budget-exceeded` |
| cancelled | settle stage and attempt `cancelled` |
| permanent, validation, configuration, data-quality, model-output or infrastructure failure | settle failed without a successor |

This classification happens before the maximum-attempt decision. Same-cycle
recovery is not a new model attempt. Below the limit it may use a successor
JobAttempt with the inherited cycle. At the final attempt it rotates the lease
generation on the existing JobAttempt, because `(stage_id, attempt_number)` is
unique and recovery must not invent another physical attempt. Old owners are
fenced by the new generation. A failed retryable terminal never inherits its
cycle; it gets a repository-generated cycle only when the physical retry policy
allows another attempt.

`failJob` also consults the same durable state. If the AgentRun already passed,
an apparent handler failure can only be report publication/completion work, so
the repository keeps the stage recoverable even on the final allowed attempt.
The next claim replays the exact successful output and idempotently inserts or
finds the report by AgentRun identity. Thus both insert-before-failure and
commit-success/response-failure converge to one report and one version without
another provider call. No error text is inspected.

Migration 0006 additionally enforces at most one AgentRun per
`(stage_id, logical_execution_cycle_id)`. `beginAgentRun` looks up by trusted
cycle first and compares the full lineage, so model, Skill, snapshot or facts
drift conflicts instead of creating a second same-cycle execution.

## Fourth review correction: exact conservative pricing

Runtime price text is a canonical fixed decimal with at most nine integer
digits and six fractional digits. Explicit zero text is permitted; the minimum
positive configured price is `0.000001`. Longer fractional precision,
scientific notation, leading-zero forms, underflowing positive text and larger
integer magnitudes are invalid before `Number` conversion.

Accounting does not multiply binary floating-point values. It converts each
finite non-negative JavaScript price's canonical decimal representation into a
BigInt coefficient and decimal scale, aligns the two terms, sums exactly, and
applies integer ceiling division once. The result must fit a non-negative safe
integer. Therefore any positive price with positive token usage costs at least
one micro-unit, exact zero remains free, and overflow fails closed.

## Fourth review correction tests

File-backed close/reopen Worker tests cover retryable terminal failure before
`failJob`, the corresponding bounded graceful-stop and heartbeat lease-loss
windows, both final-attempt success crash gaps, report publication failure
before insert and after commit, true exhausted failure, old-owner/cycle drift
fencing, and report uniqueness.
Pricing tables cover the 400-digit underflow probe, the minimum accepted
positive price, lexical maximum, exact ceiling behavior and safe-integer cost
overflow. OpenSpec 8.3 remains unchecked until all original and follow-up gates
pass.

## Fifth review correction: bounded report publication recovery

Durable AgentRun success makes report publication provider-free recovery, but
it does not make persistence failures infinitely retryable. The fourth design
reclaimed the same final JobAttempt immediately and `failJob` unconditionally
overrode the Worker's exhausted physical retry decision. With a persistently
failing report repository, `runLoop` therefore observed `processed=true` on
every iteration and never reached its poll sleep.

Three approaches were evaluated:

1. Obey only the physical JobAttempt limit. This prevents a loop, but a
   `max_attempts=1` model success gets no independent publication recovery.
2. Add a report outbox and a second Job type. This gives clean isolation but
   expands the executor and migration surface beyond the approved 8.3 slice.
3. Keep the same JobAttempt and logical execution cycle while persisting a
   separate publication cycle, attempt counter, retry policy and next-eligible
   time. This is selected because it preserves the provider identity and all
   existing lease fencing while making persistence retry independently bounded.

Migration 0006 stores `report_publication_cycle`, the count used in that cycle,
the immutable max/initial/max-delay policy captured on its first failure, and
`report_publication_retry_at`. The policy comes from the already validated
Worker retry configuration, but its counter is independent of physical model
attempt numbers. Repository constraints reject partial policies, decreasing
counters, malformed timestamps and invalid publication-cycle resets.

When `failJob` observes a same-cycle passed/succeeded AgentRun and a temporary
handler failure, it reads a fresh transaction-entry clock, then increments the
publication counter under the current lease. Below the persisted publication
limit it stores deterministic exponential backoff from that transaction clock
(never a delayed Worker timestamp) and returns the stage to queued. At the limit it stores a fixed safe
publication-exhausted error and leaves the stage and JobAttempt failed and
non-retryable. It never changes this outcome merely because the AgentRun is
successful. Claim eligibility respects the future publication timestamp, and
report-only/completion-only work always rotates the same JobAttempt lease rather
than consuming a model attempt or creating a physical successor.

An explicit manual retry of a failed stage whose latest cycle has a successful
AgentRun opens a new publication cycle on that same JobAttempt: it increments
the publication cycle ordinal, clears the publication counter/policy/deadline,
and queues the same logical execution cycle. The next Worker replays the exact
successful output and cannot call the provider. Ordinary failed-stage retry and
succeeded-stage rerun retain their existing new logical-cycle behavior.

Real `start`/`runLoop`/`stop` tests use persistent before-insert publication
failure with both physical `maxAttempts=1` and the normal limit. They assert a
finite publication count, future eligibility that prevents reclaim before the
persisted deadline, durable count/policy preservation across reopen, one provider call and a stable failed
stage after exhaustion. Additional tests cover one transient failure followed
by success, commit-success/response-failure idempotency, two-worker claim
exclusion and provider-free manual publication recovery. OpenSpec 8.3 remains
unchecked until the complete gate set passes again.

## Fifth review correction: trusted abort authority

`AbortSignal.aborted` alone cannot mean user cancellation. The same signal is
used for an explicit run cancellation, bounded Worker shutdown and heartbeat
lease loss. Treating every provider `aborted` error as `CANCELLED` lets an
infrastructure event write durable user intent that never occurred.

Three approaches were evaluated:

1. Persist every abort as retryable infrastructure. This avoids false user
   cancellation but still lets a stopping old owner finalize while its lease is
   valid, and does not resolve dispatched budget state.
2. Leave every abort pending. This protects AgentRun semantics, but a dispatched
   reservation makes takeover treat the call as paid and uncertain.
3. Propagate module-branded server abort reasons and combine them with lease and
   budget authority. This is selected. Only `run-cancelled` can produce durable
   cancelled metadata. `worker-stopping` and `lease-lost` are infrastructure
   interruption reasons that cannot originate in request or model text.

Graceful stop and heartbeat failure abort the handler with `worker-stopping`
and `lease-lost` respectively, then deliberately skip JobAttempt settlement;
the durable lease expires and the next claimant establishes authority. An
infrastructure abort can persist a retryable, non-cancelled AgentRun terminal,
which repository recovery turns into a new execution cycle; it never becomes a
durable user cancellation. Dispatched budget settlement remains fenced by the
current JobAttempt/AgentRun lease, so an old owner cannot settle or publish
after takeover.

The model-provider race maps an external signal to a typed interruption, never
to a user cancellation merely because the signal fired. If a provider ignores
abort and later returns, the old JobAttempt/AgentRun/budget authority has been
superseded before its result can settle or publish, so existing fencing rejects
it. Untyped aborts and provider
abort errors without trusted `run-cancelled` authority are never persisted as
user cancellation.

Real Worker and composition-root tests hold a fake provider inside
`generateStructured`, then exercise graceful stop and heartbeat renewal failure.
They reopen SQLite, run a healthy replacement Worker, and require success with
no cancelled stage or AgentRun. A separate trusted explicit cancellation test
keeps the existing cancelled terminal contract. An ignore-abort test resolves
the old provider only after a successor lease and proves it cannot settle or
publish.
