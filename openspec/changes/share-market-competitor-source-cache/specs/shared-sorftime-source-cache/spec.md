## Purpose

为市场调研与竞品概览提供统一的供应商原始数据复用，减少重复付费采集，并在站点、凭据、时间及指标严格隔离的前提下保持报告内容与来源可信，支持并发执行、失败恢复和额度预算验证。

## ADDED Requirements

### Requirement: Equivalent reads share durable source data
The system SHALL reuse fresh equivalent read responses across modules and processes, keyed by credential scope, endpoint, operation and complete effective arguments, preserving original collection time.

#### Scenario: Market followed by competitors
- **WHEN** 150 market products are collected and 10 matching competitors request the same histories
- **THEN** the 10 overlapping histories require zero additional physical requests

#### Scenario: Shared SellerSprite and SIF responses
- **WHEN** the new provider cache flag is enabled and market or CLI consumers request equivalent allowlisted SellerSprite or SIF reads within TTL
- **THEN** they share persisted raw responses across processes, preserving original source timestamps and provider/credential/complete-argument isolation, without applying Sorftime billing rates

#### Scenario: Explicit refresh and unknown operations
- **WHEN** a consumer explicitly refreshes a request or invokes an operation outside the reviewed read allowlist
- **THEN** refresh ignores older cache entries and unknown operations are never served from or written into the shared success cache

#### Scenario: Isolation and incremental collection
- **WHEN** site, credential, metric or page differs, or 50 products are added to 100
- **THEN** only matching fresh responses are reused and all missing identities are fetched independently

### Requirement: Concurrent requests and failures are controlled
The system SHALL coalesce concurrent equivalent requests across processes, exclude upstream errors from successful cache and pause new uncached requests for a credential after quota exhaustion.

#### Scenario: Concurrent modules
- **WHEN** two processes request the same uncached read simultaneously
- **THEN** one physical collection supplies both consumers

#### Scenario: Exhausted account
- **WHEN** the supplier reports quota exhaustion
- **THEN** subsequent uncached requests in the same credential scope fail without network dispatch during the pause while fresh cached data remains readable

### Requirement: Budgets distinguish requests from billed usage
The system SHALL expose a deduplicated estimate from cached and uncached requests and record physical dispatches separately from cache hits; unknown operation costs SHALL remain unknown.

#### Scenario: Repeat analysis and retry accounting
- **WHEN** an identical request set runs again within TTL or a physical request retries
- **THEN** cached requests estimate zero new quota and each physical attempt is recorded without claiming confirmed supplier charges
