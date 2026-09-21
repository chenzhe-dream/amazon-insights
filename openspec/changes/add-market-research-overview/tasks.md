## 1. Contracts and collector

- [x] 1.1 Define explicit market scope, nullable metrics, evidence and job schemas independent of ASIN runs
- [x] 1.2 Implement exact category resolution and governed market research/statistics collection; verify missing values, scope mismatch, partial and abort behavior

## 2. Durable runtime

- [x] 2.1 Add PostgreSQL job migration and optional repository capability with organization isolation, idempotency, bounded retry and lease fencing
- [x] 2.2 Add authenticated service, routes and proxy contracts; start and stop the collector worker independently of AI availability

## 3. Page and validation

- [x] 3.1 Add market overview form, history, polling, retry and source-aware metrics in an independent page component
- [x] 3.2 Verify targeted unit, HTTP, PostgreSQL, navigation and render contracts, plus relevant type/lint checks
- [x] 3.3 Review and integrate only the approved source changes, preserving existing generated data and formal runtime state
