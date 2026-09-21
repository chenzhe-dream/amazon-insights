## ADDED Requirements
### Requirement: Scoped concise conclusions
The system SHALL derive concise audience/scenario labels only from the row's uniquely resolved saved decisions and scoped VOC sources. It SHALL keep separate products separate, retain full restrictions, and fall back to the original conclusion when safe summarization is unavailable.
#### Scenario: Ordinary audience record
- **WHEN** a supported same-scope VOC record has a structured label and long review detail
- **THEN** the conclusion shows its label and the evidence retains all original details
#### Scenario: Unknown or conflicting record
- **WHEN** a scoped observation is conditional, restricted, unknown or conflicting
- **THEN** its complete qualification is visible without expansion and never becomes an unconditional recommendation
#### Scenario: Historical or ambiguous references
- **WHEN** trace data is absent, or references are missing, ambiguous or foreign
- **THEN** the original conclusion remains available without consulting live sources
### Requirement: Lossless long text and actions
The system SHALL provide in-place expansion for long evidence and all product actions within the existing template. Risks, restrictions, pending verification and acceptance conditions SHALL remain visible.
#### Scenario: More actions than the preview limit
- **WHEN** the product definition has more actions than the initial limit
- **THEN** every remaining action is available inline and restrictive actions remain visible in the collapsed state
#### Scenario: Immutable saved report
- **WHEN** the user expands or collapses text
- **THEN** no report, source, decision ID, priority or analysis rule is changed
### Requirement: Whole-page consistent reading
The system SHALL reuse scoped concise conclusions for matching overview cards, retain their original text on demand, and keep full qualification and acceptance text visible in paragraphs. It SHALL NOT replace mismatched historical card values or synthesize a new cross-product one-line claim.
#### Scenario: Matching overview card
- **WHEN** an audience, scenario or form card exactly matches the corresponding saved definition or VOC basis
- **THEN** it uses the same concise presentation and retains its own full original text and product mapping
#### Scenario: Mismatched historical card
- **WHEN** card text differs from the saved definition row
- **THEN** its own text is preserved without borrowing another row's conclusion
#### Scenario: Complete preview
- **WHEN** the reading changes are presented for review
- **THEN** the preview includes all nine sections and allows expansion using local sample data without requesting production analysis
