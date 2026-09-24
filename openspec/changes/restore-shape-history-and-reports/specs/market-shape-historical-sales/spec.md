## Purpose
为商品形态与价格带提供独立于研究月份的可追溯单商品销量历史，通过冻结商品池和逐商品恢复保留原版的近三个月、近六个月展示能力，同时避免混用供应商数字或将缺失月份错误当作零销量。

## ADDED Requirements
### Requirement: Independent historical collection
The system SHALL collect Sorftime SalesVolume history for each frozen ASIN on new rules-v2 runs, while preserving research scope and the existing monthly analysis.
#### Scenario: Single month research
- **WHEN** a new run researches 2026-08 only
- **THEN** history returned for June, July and August is retained independently and can produce a three-month total
#### Scenario: Legacy read
- **WHEN** a rules-v1 run is read or resumed
- **THEN** no product-history steps or network calls are added
### Requirement: Exact periods and source isolation
The system SHALL sum only complete calendar intervals from a single supplier and preserve missing values and real zeros.
#### Scenario: Missing July
- **WHEN** Sorftime returns June and August but not July
- **THEN** last-three-month units are unknown with a missing-month reason, even if SellerSprite has July
### Requirement: Persistent scoped recovery
The system SHALL bind immutable source and input records to the authorized run and ASIN and retry only failed historical steps.
#### Scenario: One failed ASIN
- **WHEN** one historical request fails and the user retries it
- **THEN** successful ASIN requests are not repeated and no model calls or manual revisions are created
### Requirement: Direct history display
The system SHALL display stored monthly history directly with supplier and per-product state, including after saving a manual classification.
#### Scenario: Reopen successful run
- **WHEN** a user reopens a report
- **THEN** monthly values and complete period totals are read from storage without collection
