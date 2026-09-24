## Purpose

为已收藏项目提供可选择模块的悬浮导出预览与独立 HTML 报告，固定业务分享时的内容，避免多人继续编辑影响已导出的文件。按用户要求先落地前端，再接入完整后端结果，两个阶段分别验收。

## ADDED Requirements

### Requirement: Favorite-gated export entry
The system SHALL show the export entry only for an analysis project with a successfully loaded favorite marker. Existing load, edit and unfavorite actions SHALL retain their behavior.

#### Scenario: Not favorited or favorite status unknown
- **WHEN** a project is not favorited or favorites are still loading
- **THEN** no enabled export entry is offered

#### Scenario: Favorite is removed
- **WHEN** a previously favorited project is unfavorited
- **THEN** its export entry and any associated preview close without deleting the project

### Requirement: Floating module selection preview
The system SHALL open a modal overlay on the existing list. It SHALL show project metadata, permitted module choices, a preview area, selected count, cancel and confirmation controls. Keyboard focus and background scrolling SHALL remain scoped to the modal and return on close. The list query and scroll position SHALL be preserved.

#### Scenario: Select and close
- **WHEN** a user opens the preview, changes module choices and presses Escape or cancel
- **THEN** the choices update the preview and closing returns to the same list without navigation, analysis or download

#### Scenario: Hidden module
- **WHEN** module visibility excludes VOC
- **THEN** VOC is absent from both selection and preview

### Requirement: Honest frontend-only phase
Until the backend is connected, the frontend SHALL show real project metadata and selectable export scope only, explicitly label report content as unavailable, and disable final export. It MUST NOT fabricate report values, readiness, snapshot timestamps, progress or download success.

#### Scenario: Backend not integrated
- **WHEN** a user selects any number of modules in phase one
- **THEN** confirmation stays disabled with a visible explanation, and no export API or provider request is sent

### Requirement: Immutable complete report in backend phase
In phase two the system SHALL bind preview and HTML to the same authorized snapshot and template version. It SHALL include all selected module records, ASINs, pages, charts and expandable details; unselected modules SHALL be absent even from the file source. Missing data SHALL remain missing.

#### Scenario: Online data changes after preview
- **WHEN** another user updates the project after a preview is fixed
- **THEN** export retains the confirmed version rather than replacing it with live results

#### Scenario: Incomplete or restricted module
- **WHEN** a module is incomplete or cannot be accessed by the current user
- **THEN** the backend rejects its export and no fabricated or unrelated older result replaces it

### Requirement: Authorized offline HTML generation in backend phase
In phase two the system SHALL recheck organization, project, module and favorite eligibility on generation and download, use existing analysis results without rerunning providers, and package content and approved images for offline viewing. Failed selected modules or images SHALL not be silently omitted.

#### Scenario: Favorite or permission is revoked
- **WHEN** eligibility is revoked before confirmation or an authenticated download
- **THEN** the operation is rejected with a clear message

#### Scenario: Offline use
- **WHEN** a successfully generated complete HTML report is opened without network access
- **THEN** selected text, tables, charts and embedded images remain readable, with local detail expansion
