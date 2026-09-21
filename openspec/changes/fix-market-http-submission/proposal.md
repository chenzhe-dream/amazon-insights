## Why
On the formal LAN HTTP origin, market submission calls crypto.randomUUID before sending a request. This secure-context-only API is unavailable; overview and theme actions fail silently, while other modules show an implementation error.

## What Changes
- Use one cryptographically random UUID v4 browser helper compatible with LAN HTTP for market commands and editor IDs.
- Preserve existing request-key reuse, single-category scope, providers, and business analysis rules.
- Regress market submission on an actual insecure browser origin without consuming provider quota.

## Capabilities
### New Capabilities
- `market-http-submission`: market actions remain functional on the supported LAN HTTP deployment.

### Modified Capabilities
None.

## Impact
Market frontend components, one browser helper, browser regressions. No schema, credential, connector, or analysis-rule changes.
