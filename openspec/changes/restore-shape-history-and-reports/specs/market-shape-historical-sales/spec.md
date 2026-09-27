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
Legacy rules-v2/v3 SHALL sum only complete calendar intervals from a single supplier and preserve missing values and real zeros. New rules-v4 SHALL follow the approved reference returned-point aggregation while exposing actual available months without fabricating missing values.
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

### Requirement: Persist independent category dashboard sources
The system SHALL collect six independent Sorftime category sources on new rules-v3 shape runs and preserve previous flow plans.
#### Scenario: Reopen old report
- **WHEN** a rules-v2 task is read
- **THEN** no category collection is scheduled
#### Scenario: Partial category failure
- **WHEN** one category metric fails
- **THEN** successful metrics and product history remain available and only failed steps can be retried
### Requirement: Keep statistical periods and units explicit
The system SHALL distinguish category_report recent statistics from category_trend monthly history and from the frozen SellerSprite product sample.
#### Scenario: Estimated revenue
- **WHEN** monthly SalesCount and AvgPrice are both available
- **THEN** their product is shown as estimated revenue, with missing months kept unknown
#### Scenario: Mixed percentage bases
- **WHEN** report cards and concentration trend charts are displayed
- **THEN** cards identify sales-volume shares and trend charts identify sales-amount shares

### Requirement: Restore reference data and business flow
New rules-v4 runs SHALL use Sorftime category_report and reference product_search expansion up to 300 products, persist separate SalesVolume and SalesAmount sources, and expose provider gross_profit_margin for reference local entry classifications. The reference seven sections, 10-unit price bands, filtering, sorting and local conclusions SHALL operate without a mandatory save or model invocation.
#### Scenario: First source becomes ready
- **WHEN** Sorftime products have been stored without a manual revision
- **THEN** available sections render from saved data, unknown shapes remain unclassified, and edits update draft statistics without collection
#### Scenario: Legacy runs remain frozen
- **WHEN** a rules-v3 task is reopened after upgrade
- **THEN** its supplier, rules and source snapshots do not change and no new collection is scheduled

### Requirement: Covered calculations and immutable legacy reports
New reports SHALL show known period totals with calculable-product coverage and explicitly scoped known-volume shares; missing values SHALL NOT become observed zero. Shape price-band denominators SHALL use the full shape identity. Legacy revisions SHALL retain their calculation version.
#### Scenario: Partially returned history
- **WHEN** one product has 100 units and another lacks history
- **THEN** the group shows known units 100 with coverage 1/2, and any share is labeled as within known units
#### Scenario: Unrelated annual gap
- **WHEN** six-month evidence is complete but an annual value is missing
- **THEN** conclusions requiring only six-month evidence remain eligible and annual-dependent claims explain their gap

### Requirement: Persistent manual drafts
The system SHALL autosave actor-scoped category drafts independently of immutable report snapshots, preserve matching ASIN edits across run/capacity changes, and protect conflicting or unsynced edits.
#### Scenario: Reload or resize
- **WHEN** a user changes labels or exclusions and reloads or changes pool size
- **THEN** matching ASIN edits are restored without collection caused by draft persistence and no other actor can read the draft

### Requirement: Reusable query and recoverable progress
The system SHALL reuse an authorized equivalent active task or compatible seven-day report unless explicit refresh is requested. Concurrent equivalent submissions SHALL NOT duplicate collection. Status reads SHALL retry transient errors without collecting again.
#### Scenario: Repeated same query
- **WHEN** the same authorized query is submitted twice
- **THEN** the existing compatible run is returned and no extra provider calls are scheduled

### Requirement: Restore reference section controls
The system SHALL restore shape suggestions, applicable fixed taxonomies, batch clearing, independent shape and brand section filters, original sort metrics and the 2025 monthly-per-link column. Task details SHALL default to collapsed and report notes SHALL remain optional.
#### Scenario: Local section filtering
- **WHEN** a user filters one shape section
- **THEN** that section statistics and conclusions use the same filtered scope without changing global inclusion or other sections
