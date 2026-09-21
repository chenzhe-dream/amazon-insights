## ADDED Requirements
### Requirement: Attribute-based colors
The system SHALL resolve display colors from each child's color attributes and use identical colors in annual shares, legends, tables and monthly trends without modifying orders, shares, denominators or ASIN identities.
#### Scenario: Sorting or adding children
- **WHEN** rows are reordered or a sibling is added
- **THEN** existing children's colors remain unchanged
#### Scenario: Same color different sizes
- **WHEN** different ASINs share a color
- **THEN** they share the color but remain separate statistical entries
### Requirement: Bounded approximation and labels
The system SHALL preserve original color names, prefer supplied Chinese labels, and identify approximate color families. It SHALL use a neutral pattern when no color can be determined. No model or translation call SHALL occur without a configured provider.
#### Scenario: Rare catalog name
- **WHEN** the offline catalog recognizes a name without a Chinese translation
- **THEN** its representative color and an approximate Chinese family are displayed with the original name
#### Scenario: Non-color attribute
- **WHEN** Blue is a size or model value
- **THEN** it is not treated as a color
### Requirement: Readable colors
The system SHALL keep percentages readable on light and dark swatches, distinguish adjacent segments, and label multi-color display as schematic rather than physical area ratios.
#### Scenario: White and black
- **WHEN** white or black variants appear
- **THEN** borders and contrasting percentage text remain visible
