## ADDED Requirements
### Requirement: Historical research backfill
Historical runs and legacy favorites SHALL be importable without collection or modification of existing reports. Only explicit batch bindings SHALL combine module runs. The import SHALL retain original ownership and scope, log invalid records, and preserve existing favorites on repeated execution.
#### Scenario: Repeat historical import
- **WHEN** the same historical snapshot is imported again after a user edits favorite metadata
- **THEN** no duplicate favorites are added and the user's edits remain unchanged
#### Scenario: Legacy conditions without a run
- **WHEN** an old favorite has no explicit report binding
- **THEN** it is imported as conditions only without guessing a matching report

### Requirement: Team research project favorites
The system SHALL persist one globally shared favorite per saved research context, with title, group, note, tag, creator, timestamps and four module bindings. Repeated saves of the same context SHALL not increase project count.
#### Scenario: Save and reopen
- **WHEN** a user saves the current research and reloads
- **THEN** the project and its module bindings remain available to all authenticated users with market research permission, including users in other organizations
#### Scenario: Access control and concurrent editing
- **WHEN** an unauthorized colleague attempts modification, or an editor submits an outdated revision
- **THEN** the server rejects it without changing data
### Requirement: V2 research library
The system SHALL provide a fifth market navigation entry with a category selector, four module cards, compact statistics, searchable/filterable/paginated module history, details, group selection/creation, metadata editing and CSV export.
#### Scenario: Filter projects
- **WHEN** a user selects a group, site, status or their own projects
- **THEN** rows and exported records match the selected filters and statistics distinguish category counts from historical report counts
### Requirement: Restore existing reports without collection
The system SHALL validate task ownership or existing favorite sharing and module identities for saved task references, retain each module scope, and derive displayed status from stored task evidence.
#### Scenario: Open a saved module
- **WHEN** a user opens a module from a favorite
- **THEN** its saved task and conditions are restored without any new collection request
#### Scenario: Incomplete report
- **WHEN** a task is queued, partial, failed or unavailable
- **THEN** the corresponding state is shown instead of reporting completion

### Requirement: Cross-organization visibility
All authenticated users with market research permission SHALL see all project favorites, groups and bound reports regardless of organization. Only the creator and administrators or system owners of the originating organization SHALL edit favorite metadata.
#### Scenario: Another organization opens a favorite
- **WHEN** a permitted user in another organization opens a saved project
- **THEN** the project, groups and explicitly bound reports are readable without granting cross-organization write access or access to unrelated tasks
#### Scenario: Missing market permission
- **WHEN** a user without market research permission requests shared favorites or their reports
- **THEN** access is rejected

### Requirement: Category module hierarchy and efficient reads
The library SHALL group saved bindings by leaf category ID, show four module cards, and load only the selected category/module history page. Different sites and periods SHALL remain visible and SHALL NOT be silently combined into a complete research result. All existing records SHALL remain intact.
#### Scenario: Same category across modules and versions
- **WHEN** saved references have the same leaf category but different module kinds, months or run IDs
- **THEN** one category entry contains four module cards and each module retains its own paginated historical versions with exact report preview links
#### Scenario: Complete category indicator
- **WHEN** all four modules have ready reports for the same site, date range and period mode
- **THEN** the category may be counted as having an aligned complete set, without asserting explicit linked-batch identity
#### Scenario: Bounded listing and stable switching
- **WHEN** a user opens the library, changes category/module, or pages history
- **THEN** listing returns only summaries or the selected history page without report bodies, obsolete requests cannot overwrite the selected scope, and read failures offer retry without claiming no saved data
