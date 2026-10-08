## Purpose

将已经审核的市场调研分析流程落实为可测试的服务端执行边界，使新市场总览任务能够从保存的来源生成分维解释与完整综合报告，同时保留历史版本、缺失状态、人工修订和可追溯的规则说明，防止恢复原版前端时误恢复未经确认的计算逻辑。

## ADDED Requirements

### Requirement: Provider response coverage stays distinct from selected product membership
The system SHALL accept bounded provider responses larger than the requested product pool, preserving full raw evidence and source indexes while enforcing local selection membership.

#### Scenario: Top ten returns one hundred rows
- **WHEN** the supplier returns 100 valid product rows for a requested pool of 10
- **THEN** the selected pool contains the first ten rows in provider order and raw received coverage remains 100
- **AND** invalid or duplicate identities and mismatching scope echoes anywhere in the response remain rejected

#### Scenario: Historical response contains products outside the frozen selection
- **WHEN** a fixed ASIN query returns additional members
- **THEN** only original selected ASINs enter the product pool, their raw row indexes remain intact, and missing members stay unknown without replacement or zero filling
- **AND** response coverage and selected member count are recorded separately

#### Scenario: A saved product-month sample is smaller than its raw response
- **WHEN** a shape selection or report read replays a saved 10-member snapshot backed by 100 raw products
- **THEN** only frozen expectedRecordIds are normalized with original source indexes and compared exactly to saved records
- **AND** known historical coverage descriptions remain readable without changing source identifiers or weakening factual source and record validation

### Requirement: Keyword task switching protects unsaved edits
The system SHALL keep the current editor until a target task is successfully read, warn before discarding unsaved classification changes, and prevent switching during a revision save.

#### Scenario: Target task read fails or the operator cancels switching
- **WHEN** an operator has unsaved keyword edits and a different task cannot be read or the discard confirmation is cancelled
- **THEN** the current task, URL, draft and pending save-retry identity remain unchanged
- **AND** no revision save or new analysis is silently submitted

#### Scenario: The operator deliberately starts a new analysis
- **WHEN** the current keyword editor contains unsaved changes
- **THEN** the frontend confirms discarding them before submitting new analysis work, and cancelling preserves the current editor

### Requirement: New overview runs use the complete evidence workflow
The system SHALL create new overview analyses with a frozen complete-workflow version and matching numeric-rule and semantic identities. Successful dimension explanations SHALL feed the existing bounded synthesis process, and the saved result SHALL be readable through existing report APIs without new frontend business calculations.

#### Scenario: New analysis reaches a saved synthesis
- **WHEN** an authorized operator starts an overview with configured models and valid scoped source fixtures
- **THEN** the run proceeds through source snapshots, numeric results, dimension explanations and saved final synthesis, preserving the submitted scope and evidence references

#### Scenario: Model identity cannot be substituted
- **WHEN** only a legacy explanation model identity is available
- **THEN** the new workflow does not reuse that identity as a complete-synthesis identity, and does not produce a fabricated synthesis

### Requirement: Model unavailability preserves usable numeric results
The system SHALL retain source collection and numeric report generation when semantic execution is unavailable. Missing or failed semantics SHALL remain distinguishable from a completed comprehensive analysis, without filling gaps with zero or reverting to unapproved heuristics.

#### Scenario: Model is unconfigured
- **WHEN** a new overview starts with no synthesis model configuration
- **THEN** source and numeric steps reach a persisted readable report and model unavailability is represented without an endlessly queued semantic step

#### Scenario: Semantic output fails validation
- **WHEN** a model step returns invalid evidence references or an invalid output contract
- **THEN** successful numeric artifacts remain readable, the failed step is identifiable, and a retry preserves successful unrelated attempts

#### Scenario: Configuration disappears during semantic processing
- **WHEN** a complete overview already has queued semantic preparation or model steps and the service restarts without model configuration
- **THEN** those steps receive an explicit configuration-unavailable terminal state, successful attempts and their audit records are preserved, and numeric reports remain readable without additional model calls

#### Scenario: Only final report persistence remains
- **WHEN** validated synthesis model output is already saved and the service restarts without model configuration before saving the final report
- **THEN** the system can still validate and persist that final report without executing the model again

### Requirement: Overview distribution sampling is independent and versioned
New overview commands MAY provide a distribution `sampleSize` of 50, 100 or 200. The system SHALL preserve `headTopN` (5, 10 or 20) as a separate basic/concentration parameter, SHALL use the original fixed Top100 for product, brand and seller concentration, and SHALL bind the sample size to the command, saved run parameters, source step identity and upstream request. Legacy runs without `sampleSize` SHALL replay their frozen step input and remain readable.

#### Scenario: A new run selects a 200-item distribution sample
- **WHEN** an operator starts a new overview with `headTopN=10` and `sampleSize=200`
- **THEN** price, rating, listing and seller-type distributions request `topN=200`, while product, brand and seller concentration request `topN=100`
- **AND** basic head metrics continue to use `headTopN=10`; changing either parameter changes the saved command identity and cannot reuse the other run

#### Scenario: An old run has no sample-size field
- **WHEN** a saved overview created before this parameter exists is replayed or read
- **THEN** its original step payload and source semantics remain unchanged, with the compatibility default used only for lookup of an equivalent new UI request
- **AND** the read performs no new collection

### Requirement: Existing commands and historical analyses keep frozen semantics
The system SHALL preserve existing run versions and reports across the entrypoint upgrade. Repeating a creation command with the same organization, study, module and public parameters SHALL return its original run even after deployment or model identity changes; conflicting public parameters SHALL be rejected. Read-only history SHALL NOT trigger collection or model calls.

#### Scenario: Legacy command is replayed after upgrade
- **WHEN** the operator repeats the same command that originally created a v3 overview
- **THEN** the original v3 run is returned without migration, additional run creation or changed source steps

#### Scenario: Reused key has different parameters
- **WHEN** a command key is reused for different study or head/sample parameters
- **THEN** the request is rejected instead of returning unrelated analysis or starting another paid collection

#### Scenario: Historical and current reports are read
- **WHEN** a saved report is requested repeatedly
- **THEN** source and model invocation counts do not increase and saved versions remain unchanged

### Requirement: Four-module rules and capability gaps remain explicit
The system's operator documentation SHALL distinguish deterministic calculations, model tasks, manual revisions, verified inputs and missing capabilities for all four market modules. It SHALL describe the formal direct-API credential boundary, avoid claims about unavailable original Cursor prompts, distinguish calendar growth from equal-window growth, and identify Customers Say as aggregated evidence.

#### Scenario: A required scoring input is unavailable
- **WHEN** the operator consults the keyword scoring capability inventory
- **THEN** unavailable supply/demand, SPR, currency-confirmed bid, price, seasonality and lifecycle inputs or rules are named with the prerequisites for later implementation, rather than claimed as finished or guessed by a model

#### Scenario: Frontend and credentials retain their boundaries
- **WHEN** the new backend workflow is implemented and tested
- **THEN** the original frontend layout remains intact and the new execution path does not depend on a Cursor process or personal Cursor configuration

#### Scenario: Operator opens rule definitions on a historical overview
- **WHEN** the operator expands the report's analysis rules
- **THEN** the saved scope, versions and metric numerator/denominator references are shown without starting a task, and an unknown formula version is explicitly marked as undocumented instead of applying another version's explanation

### Requirement: All module creation commands preserve original public intent
The system SHALL replay existing shape-price, keyword and customer-theme creation commands by organization, study, module and canonical public parameters before evaluating current model configuration or new-source date admission. It SHALL preserve frozen versions and reject changed intent.

#### Scenario: Configuration disappears after a theme command was accepted
- **WHEN** the same authorized command is retried after the model becomes unavailable
- **THEN** the original run is returned without requiring a model or creating a second analysis

#### Scenario: Concurrent module starts observe different runtime configurations
- **WHEN** identical public commands race during a configuration change
- **THEN** both resolve to the same committed run, while changed catalog, parameters, study or module are rejected

### Requirement: Keyword score input audit explains saved evidence without changing scoring
The system SHALL expose an optional independently versioned score-input audit bound to the saved keyword facts and rule report, preserving all existing report identities, numerical rules and pending scores.

#### Scenario: Saved bids have different evidence gaps
- **WHEN** a frozen member has a USD page recommendation with unspecified source window and a reference-month trend recommendation with unknown currency
- **THEN** the audit SHALL show both observations separately with their saved source references and distinct blockers
- **AND** neither observation SHALL become actual CPC or a usable cluster suggested-bid score

#### Scenario: Original-member ABA exists but cluster aggregation is unavailable
- **WHEN** a member has a verified Top3 click share of zero and another member failed collection
- **THEN** the audit SHALL count the zero as known, preserve both member states and source paths, and explain the missing cluster aggregation method
- **AND** PVS SHALL remain pending; conversion share alone SHALL NOT establish click-share coverage

#### Scenario: Operator inspects partial scoring and historical reports
- **WHEN** the operator expands the existing scoring details
- **THEN** the UI SHALL explain each missing field's required source and blocker, plus the version-bound mid-rank and PVS formulas
- **AND** history reads SHALL NOT collect data, call models, regroup members or modify facts/report hashes
- **AND** old responses without an audit SHALL remain readable, while an audit attached to foreign facts/report/classification members SHALL be rejected

### Requirement: Keyword business output projection covers the ZIP 14-item document
The system SHALL expose the ZIP business document's 14 outputs in a fixed order beside the preserved W1–W5/PVS report. Each output SHALL be marked `ready` only when its conclusion has saved keyword-fact references; otherwise it SHALL remain `pending` with explicit missing evidence. The projection SHALL NOT turn PVS estimates into formal competition, profit, price or opportunity conclusions.

#### Scenario: Operator opens a keyword report with partial business evidence
- **WHEN** the saved keyword estimate is rendered
- **THEN** demand, audience, scenario, features, development and next-step outputs use the available keyword/trend evidence
- **AND** purchase motivation, unmet needs, price, formal competition and other unsupported outputs show a concrete pending reason
- **AND** reading the report does not collect a new source, call a model, or change the original W1–W5/PVS values

### Requirement: Shape source fields remain evidence-bound across public reads
The system SHALL expose the already-collected reference product revenue, rating, rating count, seller name, seller type and valid listing date with frozen source provenance. Missing or invalid values SHALL remain null and revenue SHALL NOT be inferred from price and sales. No additional supplier or model requests SHALL be issued by reading these fields.

#### Scenario: Saved product fields are available
- **WHEN** an authorized operator reads a shape run whose frozen source contains normalized product metadata
- **THEN** the existing product columns receive those values with reference snapshot, source path and observation basis while invalid or unavailable fields remain unknown

### Requirement: Shape period projections preserve saved catalog semantics
The system SHALL expose a separately versioned read projection bound to the saved catalog identity for trailing three/six months, the two prior calendar years and the study window. It SHALL compute only fully saved periods using the original whole-study comparable cohort, preserve unknown and zero distinctions, and leave catalog bytes, hashes and model input unchanged.

#### Scenario: A saved study includes a complete trailing period
- **WHEN** a longer saved study includes every month of a requested trailing period
- **THEN** backend shape, price-band, brand and listing-year tables show totals, explicit denominators and monthly efficiencies from that period without recollection or frontend aggregation

#### Scenario: A period or member lacks observations
- **WHEN** a requested period extends beyond saved scope or a member is excluded from the original comparable cohort
- **THEN** the period is unavailable or the member stays excluded, missing months are not zero-filled, and unknown listing years remain separate from known years

#### Scenario: Historical catalog is reopened
- **WHEN** an older saved revision is read with the new projection
- **THEN** its stored catalog and hash remain unchanged, its original admission rules remain effective and neither supplier nor model invocation counts increase

### Requirement: Theme sample metadata and independent selection revisions
The system SHALL expose frozen sample title, provider rank and source summary with evidence or missing reasons without changing existing theme report hashes. Images absent from the verified source contract SHALL remain unavailable without collection.

#### Scenario: Exclusion and restoration reuse frozen facts
- **WHEN** an authorized operator excludes original selected ASINs or restores them
- **THEN** the system saves an immutable revision anchored to the same base report, recalculates counts and denominators from complete retained ASIN facts using inherited validated mappings, and makes no source/model calls
- **AND** excluded ASINs are not replaced, all-excluded totals are null, prior reports/revisions remain replayable, and positive/negative overlap and summary-source limitations remain visible

#### Scenario: Concurrent or repeated revision commands
- **WHEN** the same actor replays a command with the same key and payload
- **THEN** the original revision is returned without new work
- **AND** changed payloads, stale expected parents, foreign ASINs, inactive users and cross-organization access are rejected

#### Scenario: Historical report and revision reads
- **WHEN** source/model configuration changes or a newer source attempt completes
- **THEN** old v1/v2 hashes and saved revision facts remain unchanged and historical reads cause zero external calls

### Requirement: Theme sentiment counts precede display truncation
The system SHALL calculate positive and negative group totals from complete retained facts, independently of saved topN and response preview limits, while respecting those limits for displayed groups.

#### Scenario: A negative group is outside the saved topN
- **WHEN** retained facts include a negative group but topN excludes it from the displayed report
- **THEN** negative sentiment totals remain present and the UI explains the display omission instead of claiming no negative themes
- **AND** zero topN still retains complete statistics and existing base reports remain unchanged

### Requirement: Narrow shape tables keep evidence controls reachable
The system SHALL keep saved source details reachable by ordinary pointer interaction on narrow viewports without changing desktop layout or statistical behavior.

#### Scenario: An operator scrolls to the evidence column on a phone
- **WHEN** the viewport is at most 640px wide and the operator scrolls the shape product table horizontally
- **THEN** the product identity column scrolls with the table instead of intercepting the evidence control
- **AND** the evidence expands by ordinary click, the page does not overflow and no analysis request is created

### Requirement: Browser proxy reaches registered module operations
The system SHALL register strict public contracts for keyword create/read/revisions and theme selection operations and resolve content-addressed revision path parameters.

#### Scenario: An operator opens a saved revision through the frontend
- **WHEN** an authenticated request reaches the same-origin proxy with a valid encoded revision ID
- **THEN** it reaches the appropriate validated backend history route and returns the saved version
- **AND** unsupported paths, invalid IDs, unexpected input fields and unauthorized requests remain rejected

### Requirement: Keyword trend missing bids and month conflicts preserve independent evidence
The system SHALL retain independently valid monthly search observations when a recommended bid is the observed unusable negative value -1 (whose supplier meaning is undocumented), and SHALL preserve raw source evidence and field issues. A conflicting month SHALL remain unknown for that metric rather than selecting the first or last value.

#### Scenario: Supplier returns a negative missing bid and duplicate month
- **WHEN** keyword_trend returns valid search volumes and recommended bid -1 or -1.00, including repeated identical months
- **THEN** the bid remains null with a missing issue, duplicates are explicit, and valid search volumes and their calendar growth remain usable
- **AND** no currency is inferred and no zero or actual CPC is fabricated

#### Scenario: Multiple observations conflict for one metric and month
- **WHEN** a trend metric contains different valid values, or both missing and valid values, for the same month
- **THEN** that metric and month remains null with a conflicting-month issue, regardless of source ordering, while independent months and metrics remain intact
- **AND** malformed syntax, unsafe numbers, unsupported negative values and identity mismatches remain rejected

### Requirement: Full-request admission uses versioned model-aware token estimates
The system SHALL count the complete transport request with a locally pinned tokenizer for explicitly supported models, retain an estimation margin and framing allowance, and retain conservative byte-bound admission for unknown models. Planning and physical execution SHALL use the same policy without enlarging task budgets or weakening evidence constraints.

#### Scenario: A bounded product request contains a large fixed response schema
- **WHEN** the complete request fits its token budget including safety and repair allowances
- **THEN** planning admits it even if its UTF-8 byte length exceeds the token budget
- **AND** oversized instructions, data, schemas and repair prompts remain subject to full-request admission

#### Scenario: Metering policy changes
- **WHEN** a new run is created after a counting policy update
- **THEN** its configuration identity includes the new policy version, saved historical identities and reports stay unchanged, and reads trigger no model work

### Requirement: Cancelled market runs finalize pending model audits
The system SHALL atomically finalize pending model audits when a run is cancelled while preserving successful audit history and independent provider usage settlement.

#### Scenario: A provider returns after cancellation
- **WHEN** cancellation invalidates an in-flight model attempt
- **THEN** its audit is terminal, a late result cannot publish business output, and late usage can still settle without reopening the run
- **AND** a worker observing the cancelled audit closes normally rather than reporting a persistence failure

### Requirement: Model output failures retain safe validation diagnostics
The system SHALL expose bounded validation-stage diagnostics through the existing safe logger without including raw model output, source content or secrets.

#### Scenario: Model output fails structured validation
- **WHEN** a market model response fails parsing or contract validation
- **THEN** diagnostics identify the stage and safe validation codes or paths, while retry, repair, timeout and budget limits remain enforced

#### Scenario: Parsing fails before field validation
- **WHEN** a response envelope or JSON text is invalid before field validation can run
- **THEN** the safe logger identifies the closed parsing stage and code even when there are no field issues, without exposing response text or exception messages

### Requirement: Market provider compatibility preserves strict semantic contracts
The market runner SHALL send its output schema both in native structured format and explicitly in the model prompt, accounting for the complete request and versioning this policy. It MAY normalize one whole-response JSON code fence, but SHALL retain all schema and evidence validation without field guessing.

#### Scenario: A relay ignores native schema formatting
- **WHEN** a response wraps a valid object in one JSON fence
- **THEN** only the wrapper is removed before normal validation
- **AND** extra prose, multiple blocks, arrays, invented fields, absent required members and invalid source references remain rejected

#### Scenario: A provider exceeds the requested output limit
- **WHEN** actual reported output tokens exceed the requested maximum
- **THEN** the request fails permanently with a bounded reason code and actual usage is retained for settlement
- **AND** no automatic format repair or retry is dispatched for that violation

#### Scenario: Market protocol is explicitly overridden
- **WHEN** the server configures AGENT_MARKET_MODEL_TRANSPORT
- **THEN** only market runtime transport/provider identity changes while the validated endpoint, credentials, budgets and VOC behavior remain intact
- **AND** the queue and all module identity factories use the same resolved market configuration

### Requirement: Shape suggestion requests isolate individual products
The system SHALL partition new shape suggestion work into at most one product per model batch, without removing any admitted product or its source evidence. It SHALL preserve existing timeout, output, retry and aggregate budget limits, and SHALL leave other task member caps unchanged.

#### Scenario: Ten products have complete admissible frozen evidence
- **WHEN** the shape planner processes the ten-product input under the new policy
- **THEN** it creates ten deterministic batches, each containing exactly one original product with its original evidence
- **AND** the policy records the increase from one to ten initial model requests without increasing aggregate budget ceilings

#### Scenario: Old queued configuration is encountered after the batch policy changes
- **WHEN** a worker resolves a saved task with the previous configuration identity
- **THEN** it rejects incompatible execution before provider dispatch instead of repartitioning or reinterpreting that task
- **AND** saved reports and source snapshots remain unchanged and readable

### Requirement: Local admission waits preserve physical governance
The system SHALL preserve all physical HTTP accounting and carry a bounded local admission reason and safe retry time through the connector into durable market scheduling without consuming ordinary upstream failure retry attempts.
#### Scenario: Rolling window is full
- **WHEN** local capacity refuses a dispatch
- **THEN** no HTTP call occurs and work waits until a safe retry time, rechecking capacity and cancellation before dispatch.
### Requirement: Task-scoped MCP sessions retain isolation
The system SHALL bound and reuse scoped market sessions within the same organization, task, credential identity and endpoint, with independent request cancellation, idle retirement and shutdown cleanup.
#### Scenario: Repeated calls share a task
- **WHEN** a valid session is reused
- **THEN** redundant handshakes are avoided while every actual HTTP dispatch retains correct physical governance and no other task shares its credential or cancellation context.

#### Scenario: Completed RPC reaches its former deadline
- **WHEN** a successful RPC's original deadline passes or its caller subsequently aborts
- **THEN** no cancellation notification or new governed request is dispatched and the session remains reusable
- **AND** queued and in-flight cancellation and no-replay behavior remain enforced
### Requirement: Exact live shape span normalization preserves evidence authority
The system SHALL repair only live shape coordinates with one exact match in the already referenced same-ASIN field, retain provenance, and validate the result with existing business rules. Historical outputs SHALL NOT be rewritten.
#### Scenario: A quote has ambiguous positions
- **WHEN** invalid coordinates accompany multiple or no exact matches
- **THEN** validation fails explicitly without selecting an arbitrary match or converting a protocol error to business unknown.
### Requirement: Bounded network diagnostics and terminal acceptance
The system SHALL expose safe observable network phases and bounded versioned market timeout policy without automatic endpoint fallback. Acceptance SHALL wait for durable terminal state or its overall deadline.
#### Scenario: No work is ready during cooldown
- **WHEN** tick returns false and queued work has a future attempt time
- **THEN** acceptance waits and rechecks rather than treating this as completion.
