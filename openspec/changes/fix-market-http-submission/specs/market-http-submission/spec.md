## ADDED Requirements
### Requirement: Market commands support the LAN HTTP origin
The system SHALL generate valid random UUID v4 command identifiers without requiring crypto.randomUUID for market overview, shape, keyword, theme, and shared favorite actions.

#### Scenario: Submit a single node on HTTP
- **WHEN** an operator submits US node 1069828 for a complete month from an insecure HTTP origin
- **THEN** the browser sends the existing request with that exact node and a valid UUID v4 command key
- **AND** submission does not throw an unavailable randomUUID error

### Requirement: Request failure remains recoverable
The system SHALL preserve existing error feedback and retry idempotency for unchanged inputs.

#### Scenario: Retry after a temporary request error
- **WHEN** submission returns a temporary error and the operator retries unchanged inputs
- **THEN** the error is visible and the pending command key is reused
- **AND** no provider, category scope, or product analysis rule changes occur
