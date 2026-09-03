## Purpose

Defines truthful, scope-bound recovery for Sorftime-derived modules and image analysis, bounded restoration of sealed generated results, and safe primary-administrator control of environment-backed connector credentials.

## ADDED Requirements

### Requirement: Same-job Sorftime evidence is reusable without becoming stale cache
The system SHALL retain only allowlisted Sorftime evidence with `source=Sorftime`, ASIN, marketplace, fetchedAt, job identity, operation, and provenance. A downstream stage SHALL reuse it only when job identity, marketplace, ASIN, and operation match the current request; it MUST NOT present an older cache as current-job evidence.

#### Scenario: Matching evidence is reused
- **WHEN** SellerSprite is unavailable or returns no usable result and the current job already retained sufficient Sorftime evidence for the same ASIN and marketplace
- **THEN** the affected module uses that evidence and exposes its Sorftime provenance

#### Scenario: Stale or mismatched evidence is rejected
- **WHEN** retained evidence belongs to another job, marketplace, ASIN, or operation
- **THEN** the module does not consume it and reports a truthful empty or connector-failed outcome

### Requirement: Full gallery activates image remarks exactly once
The system SHALL persist the main image and every valid auxiliary static image from matching catalog or listing evidence. When a gallery changes from unavailable to ready, the same job/ASIN SHALL make image remarks pending exactly once; ready or terminal image results SHALL NOT be repeated, and one image failure SHALL NOT block other images, ASINs, or base modules.

#### Scenario: Catalog evidence supplies a gallery
- **WHEN** a Sorftime product-detail response contains a main image plus auxiliary images and the later listing request is unavailable
- **THEN** all valid image URLs are persisted in order and each previously unanalyzed static image is submitted at most once to the fixture image analyzer

#### Scenario: Gallery remains empty
- **WHEN** matching upstream evidence contains no usable static image
- **THEN** the page and job progress display `upstream-empty` and do not claim image analysis completed

#### Scenario: Partial image analysis failure
- **WHEN** one image analysis times out or fails while other images succeed
- **THEN** each image keeps its own outcome and other ASINs and base modules continue

### Requirement: Five modules prefer normal success then scoped Sorftime fallback
Category, FBA, Listing, price strategy, and child sales SHALL keep a usable normal-provider result first. When that result is unavailable, failed, or unusable, each module SHALL consume sufficient same-job Sorftime evidence; a verified empty result SHALL remain distinct from connection failure, and insufficient evidence SHALL NOT be fabricated into readiness.

#### Scenario: Sufficient product-detail evidence
- **WHEN** matching evidence includes fields sufficient for FBA, Listing, price, or category identity output
- **THEN** the module publishes the bounded Sorftime result with ASIN, marketplace, fetchedAt, source, and provenance

#### Scenario: Verified-empty variation evidence
- **WHEN** matching Sorftime variation evidence proves that no usable child-sales rows exist
- **THEN** child sales records a legal empty Sorftime outcome rather than connector failure

#### Scenario: Insufficient evidence after connection failure
- **WHEN** neither a usable normal result nor sufficient matching Sorftime evidence exists
- **THEN** the module reports connector failure and does not reuse old or unrelated cache

### Requirement: Primary administrator can safely switch environment credentials
The primary administrator SHALL be able to explicitly switch an environment-backed SIF, Sorftime, or SellerSprite credential to a managed credential using a one-time secret entry and confirmation. The API, browser state, response, audit text, and logs MUST NOT contain the plaintext secret. A successful save SHALL make the managed credential authoritative for new runtime resolutions and SHALL trigger or offer an immediate bounded probe with an explicit restart requirement.

#### Scenario: Environment credential is replaced by managed credential
- **WHEN** a primary administrator confirms the switch and submits a fake secret
- **THEN** the API stores a new managed version, returns safe metadata only, and the UI clears the input before probing

#### Scenario: Environment credential remains active
- **WHEN** no managed version is created
- **THEN** the UI displays `C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\formal-stack.env`, the variable name, and required restart and re-probe steps instead of only saying “server configured”

#### Scenario: Unauthorized or malformed update
- **WHEN** a non-primary user submits a credential or the request is malformed
- **THEN** the API rejects it without echoing any submitted secret

### Requirement: Sealed historical results are restored missing-only
The system SHALL restore only the six named lighting ASINs from the manifest-verified pre-switch backup into catalog, SIF keyword/enrichment/listing-traffic/monthly-traffic, and Sorftime review/rating exports. Existing canonical keys SHALL remain authoritative, the complete plan SHALL validate before any write, and sales, child, price, FBA, category, listing, image, variant, and VOC gaps SHALL remain gaps.

#### Scenario: Proven records are absent from canonical exports
- **WHEN** a requested lighting ASIN is present in a source file whose SHA matches the sealed manifest and absent from the corresponding canonical export
- **THEN** the record is inserted without replacing any other canonical record, and the recovery manifest records its source, export, and count without payload

#### Scenario: Referenced enrichment key already exists
- **WHEN** one of the 143 keywords referenced by the six restored SIF keyword records already exists in canonical enrichment
- **THEN** the canonical enrichment record is preserved and counted as covered rather than overwritten

#### Scenario: Missing-result data has no proven successful source
- **WHEN** the old backup contains only a raw sales key with business status missing or has no child, price, FBA, category, listing, image, variant, or VOC success
- **THEN** the recovery does not create or relabel a successful result for that module
