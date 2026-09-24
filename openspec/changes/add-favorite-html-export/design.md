## Context

User approved the favorite-list prototype and floating modal, then requested frontend first and backend afterward. Base: verified formal commit 2ca3ae27060672739e997dea028a21408c5b0ede. Another window is active; work is isolated in codex/favorite-html-export-ui. The legacy integrate branch and generated data are untouched.

## Goals / Non-Goals

Goals: independently reviewable frontend slice, then consistent complete immutable reports. Non-goals: changing analysis, migrating all data to PostgreSQL, automatically publishing, touching other windows, pretending prototype data is real.

## Decisions

### Phase 1: local UI only

Add an isolated ProjectExportButton/Dialog under app/project-export, rendered by ProjectLibraryPage only for favorited analysis rows with known favorite status. Pass visibleModules from the authenticated page. Reuse existing modal interaction handling (focus trap, restore, scroll lock), render via portal to escape table containers, fixed header/footer and scrollable content, responsive narrow layout.

The scope directory maps stable section IDs to existing ModuleKey gates: competitor-overview, variants-orders and listing-images belong to overview; voc, keywords, definition, checklist and traffic use their matching module keys. These are planned export sections, not claims of project readiness. The backend later supplies actual authorized availability. Unknown frontend visibility follows existing isModuleVisible behavior; the real authenticated page explicitly supplies the session values.

Display actual project name/site/ASINs and project modification time (not collection time or snapshot time). A section describes its intended content and explicitly states it is not connected. Users can check modules to verify the interaction; confirmation stays disabled with “报告数据与导出服务尚未接入，暂不能生成 HTML”. No fetch, blob or simulated success code is part of phase one. Do not re-use a false ready state just to allow a click.

Phase-one files: app/project-export/module-catalog.ts, project-export-button.tsx, project-export-dialog.tsx and project-export.module.css; small integration changes in app/project-library-panel.tsx and app/page.tsx; existing favorite browser harness extended for regression.

The selected project metadata and dialog belong to the library page, outside refreshing rows. An in-flight search must not unmount the dialog or discard module choices. Closing returns focus to the row's current export button when available.

### Phase 2: backend snapshot and renderer

Adapters read each section's authorized existing results; explicit report/run/source revision references prevent unrelated same-ASIN cache reuse. Bind organization/project/site/ASINs/capture time/module versions/template version/assets in an immutable snapshot. Validate revisions before and after assembling nontransactional sources. Use one pure renderer for full preview and standalone HTML; no DOM screenshot export. Recheck authorization/favorite status before generation and download. Keep session/task metadata in existing server storage conventions and artifacts under external runtime/data, never Git.

Proposed backend operations: create/read export-preview, read snapshot module content, create export with previewId/snapshotId/selectedModuleIds/idempotency key, read progress, authenticated file download. The phase-one component does not request nonexistent routes. Phase two adds an API adapter and replaces the explicit unavailable state, rather than changing the list entry.

Freeze assets and template version with content. Escape imported text, package CSS/charts/images without runtime login dependence, and omit all unselected module data. A failed module or image is disclosed and requires retry or explicit scope change. Retention defaults of 24h preview and 7d artifact are proposed configurable values, not new UI behavior in phase one. Downloaded copies are not remotely revocable or tamper-proof.

## Risks / Trade-offs

- Frontend-first cannot export real HTML yet → clearly label missing service, block final export, verify no write/network side effects.
- Partial generated caches are not fresh merely because ASINs match → adapters verify source identity and surface missing/unverified data.
- Many existing sections → list the complete intended catalog now; enable completed adapters individually in phase two, never silently drop selected sections.
- Other windows moving production baseline → no automatic merge/release; recheck before integration.

## Migration Plan

No schema or runtime changes in phase one. Frontend can be reverted independently. Phase two remains unchecked until its backend and offline/concurrency tests pass. User must explicitly request production publication.
