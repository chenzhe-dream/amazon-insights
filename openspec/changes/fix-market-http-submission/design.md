## Context
The formal UI is served from a private-network HTTP address. Localhost browser tests are secure contexts and hid the unavailable randomUUID API. The existing VOC implementation already uses getRandomValues successfully for this deployment.

## Goals / Non-Goals
Goal: reliable market commands and useful request errors on HTTP. Non-goals: HTTPS migration, provider changes, near-30-day support, or changes to category and product rules.

## Decisions
Generate UUID v4 with getRandomValues and RFC version/variant bits in a small browser helper. Replace market-only direct randomUUID usages, retaining existing pending-command references and keys across retries. Keep initial overview key generation inside its existing mutation error boundary.

Test a genuine insecure test hostname with browser network interception routing assets to a local Vite fixture and intercepting all API traffic. Verify randomUUID is absent, valid single-node requests are sent, errors are visible, and retries retain keys. Run existing secure-origin module and favorite regression suites.

## Risks / Trade-offs
Do not substitute Math.random or timestamps. The helper requires the broadly supported getRandomValues API. This repair does not prove provider availability or successful end-to-end paid analysis.

## Migration Plan
No data migration. Build and publish through the formal stack manager after checks and idle-job gate. Retain the prior web artifact for rollback.
