## Purpose

为团队提供与竞品 ASIN 分析相互独立的类目市场总览基础查询，明确统计月份、头部范围及新品窗口，保存可恢复的采集状态和有来源的指标，为后续类目结构、关键词及买家评论研究提供可靠的范围边界。

## ADDED Requirements

### Requirement: Explicit category scope
The system SHALL accept US category identifiers or complete numeric paths, a past complete calendar month, headTopN of 5/10/20 and a new-product window of 1/3/6/12 months. It MUST reject an ambiguous node match and MUST NOT substitute a current competitor ASIN sample for the category.

#### Scenario: Wrong first search result
- **WHEN** the provider returns a node other than the requested identifier
- **THEN** collection reports a scope error and does not use that node's metrics

#### Scenario: Current month
- **WHEN** a user submits the current or a future month
- **THEN** the request is rejected before external collection

### Requirement: Durable organization-scoped jobs
The system SHALL derive actor and organization from the authenticated session, revalidate active membership, deduplicate requests by organization and idempotency key, and retain the newest 30 jobs for display. It MUST recover expired worker leases and prevent stale workers from publishing. A failed retryable job SHALL permit explicit retry while its cumulative attempt count is below three. Successful and partial reports MUST remain immutable.

#### Scenario: Cross-organization access
- **WHEN** a different organization requests a job identifier
- **THEN** no job or report content is returned

#### Scenario: Worker recovery
- **WHEN** a worker lease expires and another worker claims the job
- **THEN** the old lease cannot renew or publish a result

#### Scenario: Repeated submit
- **WHEN** the same organization repeats the same idempotency key with the same scope
- **THEN** the existing job is returned without an additional collection

### Requirement: Evidence-based metric semantics
The system SHALL display provider sample size, sales, revenue, average price/reviews, head concentration raw values and new-product metrics when available. Missing or invalid values MUST remain unknown; an explicit zero MUST remain zero. The system SHALL preserve successful source evidence when the other endpoint fails, mark the report partial, and save provider operation, timestamp and content hash. It MUST NOT infer percentage units, growth or overall market opportunity from unverified ratios or a single month.

#### Scenario: Optional endpoint failure
- **WHEN** research succeeds but statistics times out
- **THEN** the research metrics remain available with a partial status and safe issue message

#### Scenario: Unrecognized statistics
- **WHEN** statistics returns an object without any usable recognized metric while research succeeds
- **THEN** statistics is recorded as a source issue, research remains available, and statistics is not counted as successful evidence

#### Scenario: Missing value
- **WHEN** a provider field is null or blank
- **THEN** it is displayed as unknown and is not converted to zero

### Requirement: Recoverable market overview page
The system SHALL expose a market overview entry independent of selected competitor ASINs, allow explicit submission and polling, restore job history after refresh, and clear data when the authenticated session changes. The browser MUST call the existing same-origin authenticated proxy. The page SHALL state that this batch contains basic overview metrics and that category samples are not the whole market.

#### Scenario: Session change during request
- **WHEN** an old session's pending request returns after logout or session replacement
- **THEN** its results are not shown in the new session

#### Scenario: Historical result selection
- **WHEN** a user reopens a completed job
- **THEN** the saved result and its original scope are displayed without re-collecting

#### Scenario: Slow history request
- **WHEN** a history response takes longer than the polling interval
- **THEN** no overlapping history request invalidates it and its result can still update the page

### Requirement: Organization credentials without AI execution
The system SHALL resolve a market request's data-source credentials from the job organization without requiring an AI execution identity. Credential errors MUST NOT silently select a global secret.

#### Scenario: Managed credential with no AI identity
- **WHEN** an organization has saved a SellerSprite credential and no AI execution identity is configured
- **THEN** its market worker uses that organization's credential for collection
