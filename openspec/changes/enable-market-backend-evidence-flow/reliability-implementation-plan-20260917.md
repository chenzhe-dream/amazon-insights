# Approved reliability implementation — 2026-09-17

User approved the reviewed alternative (not every external suggestion): implement now, explain connection pools. Continue in this worktree and change. Real quota testing remains authorized. Preserve the original frontend, all source/ASIN boundaries, physical request accounting, budgets, old reports and formal runtime. No deployment or cancellation of formal tasks.

This explicit continuation supersedes the older exclusion of collection scheduling/connector reliability in proposal/design solely for the bounded items below. Do not absorb unrelated collection work. Existing large dirty changes must be preserved; capture task baselines and never reset or commit the whole worktree.

## A. Local admission and durable waiting

Files: shared concurrency/connector/market execution contracts; TS and script PostgreSQL governors; remote-mcp-connector; market-source-step-handlers; market-module-execution-store; focused tests.

1. Red tests: local rolling admission preserves a closed reason and absolute retryAt; a rejected request does not dispatch HTTP; sibling organization isolation. Treat concurrency saturation separately from rolling window and paused/unavailable configuration.
2. Extend the existing error safely and compute rolling retryAt using database clock/current effective policy and active physical-attempt window, under the same admission transaction. Preserve all HTTP accounting. Do not log secrets.
3. Preserve local-admission metadata through connector and source handler. Local waiting must not consume ordinary upstream failure retry budget. Persist next_attempt_at at/after the safe retry time; cap waits with the existing overall deadline/cancellation. Non-admission upstream errors keep their existing bounded retry semantics. Avoid immediate connector-internal retries for admission rejection.
4. Tests: full window, cooldown release, concurrent waiters recheck admission, cancellation while waiting, completed siblings not recollected, no spin loop, TS/script parity. Do not pretend a manual pause has an exact release time.

## B. Task-scoped MCP session reuse

Files: sellersprite-mcp-client.mjs and a focused session manager if useful; mcp-connectors lifecycle wiring and optional close contract; service shutdown hook if required; MCP fake-server tests.

1. Red test actual SDK: same task's N calls use one handshake; different organization/task/credential/endpoint remain isolated. Keep single active RPC per reused session initially for reliable accounting.
2. Reuse only for scoped market analysis operations and within organization + job/run + credential fingerprint/version + endpoint + protocol. Use bounded entry count, idle expiry and connection setup deduplication. Do not introduce a process-wide unscoped shared client or raw credential map keys/logs.
3. Separate session lifetime from per-call abort. Every fetch remains governed with the correct task identity; a timed-out call must not terminate a different task's session. Retire unusable sessions; rebuild for a later call without silently replaying a possibly-dispatched business call.
4. Close idle sessions and all sessions owned by a stopping connector/service. Existing unscoped callers retain one-shot lifecycle. Tests cover TTL/rotation, queue cancellation, limits, shutdown and no duplicate dispatch on failure.

## C. Shape citation normalization and precise diagnostics

Files: semantic-validation and safe rule identifiers; small exact-span normalizer; semantic execution canonicalization/repair guidance and identity; targeted tests with saved real shape inputs.

1. Red tests for bounded field paths and distinct span failure reasons, including UTF-16 surrogate boundaries. No source quote text in general error logs.
2. Keep the existing persisted span shape. Only new live shape model output may repair coordinates: existing valid span stays unchanged; otherwise quote must match exactly once inside the already referenced original field owned by the same ASIN. Preserve quote/refId/decision; no trim, translation, regex/fuzzy search, alternate field or alternate ASIN. Empty, repeated, missing, foreign or surrogate-splitting references remain errors. Never convert protocol failure into business unknown.
3. Validate the normalized result with all existing semantic validators, preserve input immutability and record bounded normalization provenance (field/ref/old-new offsets/rule version). Keep historical validators strict: never rewrite an old report on read. Include new normalization policy in execution identity and appropriate repair guidance. If protocol fields cannot carry provenance, use the existing durable audit metadata with a strict additive contract, not a new business output field.
4. Tests: negative phrases unchanged; same quote in another ASIN disallowed; repeated occurrences; correct repeated quote with valid old offsets stays valid; old history unchanged; red/green real frozen input replay without model calls.

## D. Network observability, timeout policy and acceptance runner

Files: market-only model transport diagnostics helper/provider wiring; market runtime configuration/identity/tests; reusable test polling helper and maintained acceptance scripts.

1. Record bounded request phases (dispatch, headers, body completion/error, abort reason) without secrets, bodies or URL queries. Prefer existing fetch/Undici capabilities; unavailable DNS/TLS phases stay unavailable, do not force HTTP/2 or claim to see upstream queue time. Preserve default VOC behavior.
2. Keep default task timeouts unless real measurements justify adjustment. Add a bounded market-only configurable timeout (theme/shape at most120s) if consistent with validated task definitions; preserve base/task/batch/stage limits and ledger/lease cancellation. No endpoint fallback or automatic retry of ambiguous post-dispatch timeouts. Version actual configuration and regression-test concurrent cancellation/late output.
3. Poll until durable terminal state or overall test deadline, using next_attempt_at for pending work. A false tick is not completion. Use short waits so updates and cancellation remain responsive; avoid re-collecting successful siblings. Regression test cooldown then success and cancelled/final failure.
4. Real bounded acceptance after deterministic regressions: original gel-pen source scope and selected ASIN evidence; verify request accounting, retained successful outputs, no pending orphan audits and read-only GET behavior. Record actual failures without claiming four modules passed. Keep all diagnostics separate from formal runs.

## Final integration

Independently review task diffs, run relevant tests/typecheck/spec validation, review new shared contracts and version boundaries, then run real acceptance. Update tasks individually only after their promised behaviors are present. Report local implementation versus formal publication accurately.
