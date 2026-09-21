## ADDED Requirements

### Requirement: Organization scoped default policy
The system SHALL allow authorized module managers to read and save an organization scoped new-user visibility policy with optimistic version checks and audit records.
#### Scenario: Concurrent update
- **WHEN** two administrators save the same policy version
- **THEN** only one succeeds and the other receives a conflict without overwriting the committed policy
#### Scenario: Unauthorized request
- **WHEN** a caller lacks the existing module management qualification
- **THEN** both reading and updating defaults are denied even if the management module is visible

### Requirement: Creation time snapshot
The system SHALL snapshot the current policy atomically when creating a DingTalk account through the PostgreSQL first-login path and SHALL preserve existing users.
#### Scenario: First DingTalk login
- **WHEN** a new DingTalk account is created after a policy is saved
- **THEN** the account receives that policy selection and its source is marked as new-user-default
#### Scenario: Returning user
- **WHEN** a DingTalk user logs in again after a defaults change
- **THEN** their existing visibility remains unchanged
#### Scenario: Empty selection and owner
- **WHEN** the default selection is empty
- **THEN** new ordinary DingTalk users have no visible modules while system owners retain all modules and privileged pages retain their original authorization checks

### Requirement: Registry driven options
The system SHALL generate policy options and visibility validation from the shared module registry. New modules SHALL require explicit administrator selection before inclusion in new-user defaults.
#### Scenario: Newly registered parent module
- **WHEN** a parent module is added to the registry
- **THEN** it appears in both configuration lists and is not automatically included in stored or initial default policy selections
#### Scenario: Unconfigured installation
- **WHEN** no policy has been saved
- **THEN** the frozen original nine-module baseline is used for new DingTalk accounts without changing existing users

### Requirement: Default policy editor
The system SHALL expose a separate default-policy drawer with clear scope, cancellation, load errors and conflict feedback.
#### Scenario: Save defaults
- **WHEN** an administrator selects modules and saves
- **THEN** the selection persists and the UI explains that only subsequently created DingTalk accounts inherit it
#### Scenario: Failed read or cancellation
- **WHEN** loading fails or the administrator cancels
- **THEN** no policy is saved and an unsuccessful read cannot be used to overwrite defaults

### Requirement: Preserve local accounts
The system SHALL leave local accounts and their existing management qualifications unchanged. The existing individual configuration list SHALL remain scoped to active non-archived DingTalk accounts in the organization.
#### Scenario: Local management account
- **WHEN** the default policy is edited or cleared
- **THEN** the existing local management account retains its visibility and management access; other local accounts are neither modified nor deleted
#### Scenario: Local creation path
- **WHEN** a local account is created after the default policy is saved
- **THEN** the existing local-account behavior remains unchanged and no DingTalk default snapshot is applied
