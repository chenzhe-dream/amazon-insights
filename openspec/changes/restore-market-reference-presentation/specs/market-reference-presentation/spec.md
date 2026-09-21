## ADDED Requirements
### Requirement: Separate presentation from original analysis and providers
The restored modules SHALL expose presentation over current saved outputs, retain an explicit map of original analytical dimensions, and prevent presentation imports from reaching original provider implementations or synthetic preview data.
#### Scenario: Original report contains a business calculation
- **WHEN** an original report component calculates a score or conclusion locally
- **THEN** the extraction retains its analytical purpose in the mapping and renders the corresponding current saved result
- **AND** any missing capability is visibly identified instead of running the old calculation or inventing an equivalent score

### Requirement: Original after-analysis structure is preserved
The four market modules SHALL present the original report sections, charts and table hierarchy where current saved data supports them, preserving unavailable sections explicitly and keeping useful existing operations accessible.
#### Scenario: An original section has no current evidence
- **WHEN** a report is displayed without a supported source for an original dimension
- **THEN** the section states the missing data or capability and no synthetic values are rendered

### Requirement: Current backend remains authoritative
The frontend SHALL consume existing saved backend outputs, task APIs and identifiers without importing original providers, calculations or schema changes.
#### Scenario: Original reference field is absent
- **WHEN** the original layout includes a metric not returned by the current backend
- **THEN** the UI shows an explicit unknown or missing state and does not infer a replacement value

### Requirement: Overview uses inline report presentation
The UI SHALL expose a report action in the selected result row and show the report inline, with compact auxiliary task controls.
#### Scenario: Open a result report
- **WHEN** the operator explicitly opens a selected result report
- **THEN** the existing task API receives that result's scope
- **AND** reopening the same loaded report or restoring a saved URL does not start another task

### Requirement: Preserve supported frontend functions
The four modules SHALL retain errors, retries, report versions, manual classification, shared favorites and copy/pagination while restoring reference presentation.
#### Scenario: Read a partially available report
- **WHEN** some sources are missing or failed
- **THEN** available saved results remain visible and gaps and retry controls remain accessible
