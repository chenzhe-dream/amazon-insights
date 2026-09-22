## Purpose

为四个市场模块保存可复算的确定性规则基线，使数字结果在模型失败后仍然可读，并作为后续 Agent 解释的唯一数字输入。

## ADDED Requirements

### Requirement: Overview baseline reproduces saved catalog facts
The overview rule baseline MUST be built only from the saved overview catalog. Known metrics MUST keep their numeric value, unit, and in-scope evidence. A real zero MUST stay zero. Empty demand trend and unconfirmed concentration units MUST stay missing with a reason.

#### Scenario: Complete saved distribution keeps a real zero
- **WHEN** a saved overview catalog contains a distribution row whose unit count is zero and that row cites a frozen source
- **THEN** the overview baseline records that metric as zero with evidence
- **AND** the baseline does not replace zero with a missing reason

#### Scenario: Empty demand and unconfirmed concentration stay missing
- **WHEN** the saved catalog has no demand-trend values and a concentration field has no confirmed unit
- **THEN** those fields are missing with reasons
- **AND** they are not stored as zero

### Requirement: Overview baseline does not claim semantic synthesis
An overview baseline MUST remain readable when no semantic window has succeeded. Its status MUST describe only the deterministic catalog. It MUST NOT report semantic synthesis as complete.

#### Scenario: Numeric catalog without an AI window
- **WHEN** the saved catalog has deterministic metrics and no succeeded semantic window
- **THEN** the baseline status is complete, partial, or unavailable according to those metrics and gaps
- **AND** the baseline rule version is the catalog version rather than a synthesis version

### Requirement: Rule baseline replay does not call external systems
Rebuilding a rule baseline from the same frozen snapshot and deterministic projection MUST return the same metrics, missing reasons, and evidence references. The rebuild MUST NOT call a model or a source connector.

#### Scenario: Same overview catalog is rebuilt
- **WHEN** the overview baseline is built twice from the same saved catalog
- **THEN** both results are deeply equal
- **AND** the builder does not import model runtime or source connectors
