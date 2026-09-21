## Context

See proposal.md for the first increment. The current runtime is vinext → same-origin proxy → Fastify → PostgreSQL. Existing report/snapshot stores verify an ASIN-bound analysis run, so reusing them for a category would violate their subject checks. Reference ZIP code is requirements evidence only; its script/localStorage and hard-coded conclusion mechanisms are not runtime instructions.

## Goals / Non-Goals

Goals: independently scoped, recoverable basic market overview; a narrow page mount; existing connector credential and request governance; strict unknown/zero distinction.

Non-Goals: all 14 detailed overview sections, opportunity scores, shape classification, category keyword expansion, TOP20 Customers Say, new AI prompts, formal-service rollout. These are later independently testable increments, not fulfilled by the initial overview page.

## Decisions

- Use a new optional `marketResearch` repository capability and a dedicated PostgreSQL job table. Alternatives were forcing category data into ASIN snapshots or migrating all existing run contracts; both would expand the change and weaken existing scope checks. SQLite reports unavailable instead of inventing process-only persistence.
- Store a normalized immutable report, explicit scope, safe errors and source hashes. Terminal successful/partial records cannot be overwritten; refreshing creates a new job. Organization and actor are never accepted from request bodies.
- Run a separate bounded worker using existing governed connectors, independent of AI availability. Claim with SKIP LOCKED, renew every20s, lease120s, collection deadline60s, cumulative maximum3 attempts. Expired final attempts become failed; transient failures are explicit user retries.
- Accept numeric node IDs or numeric paths initially. A single ID must resolve uniquely to the requested leaf; research rows must match. A category name input will require explicit candidate selection in a later increment.
- Keep CRn values as upstream raw numbers until units are verified. Do not apply the old heuristic of multiplying every value <=1 by100. Unknown fields are null. The sample count is reported by the source; this increment has no configurable distribution sampleSize because no distribution request is issued.
- Reuse the current signed-in page shell but keep form, history, polling and result components in a dedicated module. The frontend and backend register the same schemas through the proxy contract whitelist.
- Resolve connector credentials from the persisted job's organization even when no AI execution identity is configured. Unscoped legacy calls retain their execution-organization or environment fallback. Managed-credential failures do not silently switch to another secret.
- Poll history with one request in flight; a slow response must remain eligible to update the page. Use UTC calendar-month boundaries in both form validation and the service.
- Validate usable metrics per endpoint before accepting evidence. Preserve completed endpoint data at the shared collection deadline; explicit worker cancellation still cancels the whole result.

## Provider Contract Check

On 2026-09-12, read-only SellerSprite `tools/list` discovery confirmed the three current input definitions: `product_node` uses `keyword` and `month` (`yyyyMM`), `market_research` accepts `nodeIdPath`, `newProduct`, `topNum`, `page` and `size`, and `market_research_statistics` uses `topN` for the same scope. This verifies request shapes only; no live category job was submitted and response units still require business acceptance.

## Risks / Trade-offs

- Vendor payload variation → strict scope matching, safe partial/failure states, fixture-based contract tests, live business acceptance remains pending.
- External quota use → user starts each job explicitly; idempotency and the existing resource governor apply to every physical request.
- Manual retry after an interrupted network attempt can repeat a physical request → bounded retries and clear attempts; no claim of exactly-once vendor billing.
- First increment is narrower than the ZIP total overview → page and docs explicitly state the basic-metrics boundary. Follow-up: obtain one immutable category_report sample to feed both shape and TOP20 review modules, then add keyword seed expansion with W1-W5 sample semantics.

## Migration Plan

Add migration0033 and source code to the current integration checkout after isolated validation. Do not apply migrations against the formal database or restart the formal stack during this development turn. On a later authorized rollout, the normal PostgreSQL startup migration creates the additive table. Reverting the source disables new routes while retaining the table and history; no destructive down-migration is required.
