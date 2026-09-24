## Purpose

为已收藏项目提供模块可选的悬浮预览和 HTML 快照下载，把当时已有报告的文字、表格、结论与样式保存在文件，避免线上继续编辑影响已分享内容。图片允许在线读取，不要求断网可用；复用已有结果，不重新分析，不建设导出任务与文件管理。

## ADDED Requirements

### Requirement: Favorite-gated export entry
The system SHALL offer export only for favorited analysis projects with known eligibility and current read access. Load, edit and unfavorite SHALL retain existing behavior. A known session, scope or eligibility change SHALL invalidate pending export.

#### Scenario: Unknown or absent favorite
- **WHEN** favorite status is unknown or the project is not favorited
- **THEN** export is not enabled

#### Scenario: Eligibility revoked
- **WHEN** the application learns of logout, removed favorite or revoked read access
- **THEN** it clears pending export and prevents confirmation without deleting the project

### Requirement: Floating module selection preview
The system SHALL keep permitted module selection and full preview in a modal on the existing list. It SHALL preserve list search, pagination and scroll position, constrain keyboard focus, support Escape/cancel, and restore focus on close. A list refresh SHALL NOT dismiss the modal.

#### Scenario: Change selection
- **WHEN** selection changes
- **THEN** preview includes only selected permitted modules and confirmation waits until preparation completes

#### Scenario: No selection
- **WHEN** all modules are deselected
- **THEN** the system explains that one module is required and prevents download

### Requirement: Honest frontend-only transition
Until real report preparation is connected, the system SHALL label contents as unavailable and disable final download. It MUST NOT fabricate report results, readiness or download success.

#### Scenario: UI only
- **WHEN** no real report reader is connected
- **THEN** real project metadata and intended scope remain visible with an unavailable message and no fake export

### Requirement: Complete scoped existing results
The system SHALL read existing results bound to the selected project, marketplace, ASIN set and applicable run or report references. It SHALL include all available selected records, pages and collapsed details, preserving existing analysis rules and missing-value semantics. It MUST NOT trigger collection, model analysis, normalization or repair jobs.

#### Scenario: Same ASIN across projects
- **WHEN** multiple projects contain the same ASIN
- **THEN** export follows the selected project's bindings rather than substituting another project's data solely by ASIN

#### Scenario: Authorized existing variant cache
- **WHEN** the selected variant/order page uses shared marketplace and ASIN caches without a published run binding
- **THEN** export MAY read that existing cache after project authorization, exact source scope and strict format checks, SHALL verify read stability including translated attributes, and SHALL label its actual source and time without claiming published-run provenance

#### Scenario: Current page and saved history differ
- **WHEN** current saved inputs differ from a historic local rule report
- **THEN** export SHALL preserve the current page's pure display computation and identify any included historical result separately; it SHALL NOT substitute a historic checklist for the current checklist or automatically enable review fallback

#### Scenario: Historical rules
- **WHEN** a saved result includes its own rule definitions and decision versions
- **THEN** export SHALL retain those original definitions and versions and label any current rules as comparison material

#### Scenario: Pagination and incomplete sources
- **WHEN** a selected module has multiple pages, missing values or an upstream Top N limit
- **THEN** all existing rows and details are included, missing is not zero and source limitations remain explicit

#### Scenario: No generated result
- **WHEN** a selected module has no existing result
- **THEN** preview and HTML explicitly show that status without creating new analysis

#### Scenario: Read failure
- **WHEN** an existing result fails to load or has mismatched provenance
- **THEN** confirmation is blocked until a successful retry or explicit deselection of that module

#### Scenario: Optional selling point translation
- **WHEN** the authorized report contains original selling points but a Chinese translation is missing, pending, failed, unconfigured or temporarily unreadable
- **THEN** export SHALL retain all available originals from that report, explicitly label translation availability and SHALL NOT generate a translation; confirmed source mismatches, invalid responses and authorization failures SHALL still block export

#### Scenario: Selling point report version
- **WHEN** export reads a saved selling point translation
- **THEN** it SHALL pin the prepared published report version and verify the original against that report, SHALL NOT read a generated workspace catalog, and SHALL reject a changed report version

#### Scenario: Partial published catalog
- **WHEN** a published report lacks some selected products' catalog entries
- **THEN** export SHALL preserve the selected ASIN scope and existing VOC, definition and checklist sources, label missing product information, keep numeric values unknown and use the generic product family without importing another project's product data

#### Scenario: Unsaved checklist entries
- **WHEN** checklist edits only existed in an unmounted page's component state
- **THEN** export does not pretend to recover them and preview explicitly identifies those unsaved entries as excluded

### Requirement: Frozen identical preview and HTML
The system SHALL prepare a fixed report in browser memory and preview the same HTML that will be downloaded. Online updates after preparation SHALL NOT replace its content. Selection changes SHALL require an updated preview. Unselected content SHALL be absent from the file, including hidden markup and serialized payloads.

#### Scenario: Online edit after preview
- **WHEN** another user updates the project after preparation
- **THEN** download retains the previewed text and data without refetching replacement content

#### Scenario: Remove VOC from selection
- **WHEN** VOC is deselected
- **THEN** the next preview and file contain no VOC section or hidden VOC payload

### Requirement: Browser HTML download with online images
The system SHALL download one UTF-8 HTML file directly from the browser, containing report text, tables, static charts and required styles. Images SHALL use shareable absolute online URLs without dependence on local host or the exporting user's session. Opening the report SHALL NOT fetch live analysis results. Server export queues, stored export artifacts, expiration and offline image packaging are outside this capability.

#### Scenario: Open on another computer
- **WHEN** a recipient opens the downloaded file with network access
- **THEN** the fixed report is readable without application login, and images use online source URLs

#### Scenario: Unavailable image
- **WHEN** an online image later fails or lacks a shareable URL
- **THEN** descriptive text remains and the fixed report stays readable without claiming the image was preserved

#### Scenario: Unsafe imported text
- **WHEN** titles, reviews or remarks contain executable HTML or unsafe links
- **THEN** content is safely rendered and cannot execute injected code or include session credentials

#### Scenario: Download confirmation
- **WHEN** the user confirms an eligible prepared report
- **THEN** the browser initiates a file download using the preview HTML and does not require a server-side export job or stored file
