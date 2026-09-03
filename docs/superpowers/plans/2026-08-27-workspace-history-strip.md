# Workspace History Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current analysis workspace and five recent workspaces visible while moving all remaining workspace links into a collapsed history group.

**Architecture:** A new presentation-only component owns deterministic workspace partitioning and rendering. `app/page.tsx` supplies the existing project records and current project id; storage, URLs, project APIs, and database schemas remain unchanged.

**Tech Stack:** React 19, TypeScript, node:test, React server rendering, ESLint.

## Global Constraints

- Current stable version is frozen; work in an independent worktree and branch.
- Do not delete or modify historical projects, existing jobs, runtime data, or generated data.
- Do not add database migrations, archive fields, delete controls, or provider calls.
- Run one focused implementation verification and one independent limited review; only Critical or direct business blockers permit rework.
- Preserve protected business WIP and keep the index limited to this task.

---

### Task 1: Deterministic workspace history strip

**Files:**
- Create: `app/workspace-history-strip.tsx`
- Modify: `app/page.tsx:90-105,3050-3090`
- Modify: `app/warm-theme.css:606-690`
- Test: `tests/agent/workspace-history-strip.test.tsx`

**Interfaces:**
- Consumes: `AnalysisProject` from `app/project-library-panel.tsx`, `currentProjectId: string | null`, and `(project: AnalysisProject) => string`.
- Produces: `selectWorkspaceSections(workspaces, currentProjectId, recentLimit?): { visible: AnalysisProject[]; history: AnalysisProject[] }` and `WorkspaceHistoryStrip`.

- [ ] **Step 1: Write the failing partition and render tests**

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { selectWorkspaceSections, WorkspaceHistoryStrip } from "../../app/workspace-history-strip";

test("current workspace remains visible beside five most recent others", () => {
  const projects = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index}`, name: `项目${index}`, slug: `p-${index}`, marketplace: "US",
    asins: ["B000000001", "B000000002", "B000000003"], majorCategory: null,
    categoryLabel: `品类${index}`, note: null, createdBy: null,
    createdAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  const result = selectWorkspaceSections(projects, "p0", 5);
  assert.deepEqual(result.visible.map(item => item.id), ["p0", "p7", "p6", "p5", "p4", "p3"]);
  assert.deepEqual(result.history.map(item => item.id), ["p2", "p1"]);
});

test("history is collapsed without removing its links", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceHistoryStrip, {
    workspaces: fixtures, currentProjectId: "p0", buildHref: project => `/p/${project.slug}`,
  }));
  assert.match(html, /历史项目（2）/);
  assert.match(html, /<details/);
  assert.match(html, /href="\/p\/p-1"/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});
```

- [ ] **Step 2: Run RED**

Run: `npm exec -- tsx --conditions=react-server --test tests/agent/workspace-history-strip.test.tsx`

Expected: FAIL because `app/workspace-history-strip.tsx` does not exist.

- [ ] **Step 3: Implement the pure partition and component**

```tsx
"use client";
import Link from "next/link";
import type { AnalysisProject } from "./project-library-panel";

export function selectWorkspaceSections(workspaces: AnalysisProject[], currentId: string | null, recentLimit = 5) {
  const sorted = [...workspaces].sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  const current = currentId ? sorted.find(item => item.id === currentId) : undefined;
  const recent = sorted.filter(item => item.id !== currentId).slice(0, recentLimit);
  const visible = current ? [current, ...recent] : recent;
  const visibleIds = new Set(visible.map(item => item.id));
  return { visible, history: sorted.filter(item => !visibleIds.has(item.id)) };
}

export function WorkspaceHistoryStrip({ workspaces, currentProjectId, buildHref }: {
  workspaces: AnalysisProject[]; currentProjectId: string | null;
  buildHref: (project: AnalysisProject) => string;
}) {
  const { visible, history } = selectWorkspaceSections(workspaces, currentProjectId);
  const links = (items: AnalysisProject[]) => items.map(workspace => (
    <Link key={workspace.id} href={buildHref(workspace)}
      className={`workspace-chip${workspace.id === currentProjectId ? " active" : ""}`}>
      {workspace.categoryLabel || workspace.name}<small>/p/{workspace.slug} · {workspace.marketplace}</small>
    </Link>
  ));
  return <div className="workspace-switcher" aria-label="已保存的分析工作区">
    {links(visible)}
    {history.length ? <details className="workspace-history"><summary>历史项目（{history.length}）</summary>
      <div className="workspace-history-items">{links(history)}</div></details> : null}
  </div>;
}
```

- [ ] **Step 4: Replace only the existing workspace chip map in `app/page.tsx`**

```tsx
<WorkspaceHistoryStrip
  workspaces={workspaces}
  currentProjectId={currentProjectId}
  buildHref={workspace => projectWorkspacePath(workspace.slug)}
/>
```

- [ ] **Step 5: Run GREEN and lint**

Run: `npm exec -- tsx --conditions=react-server --test tests/agent/workspace-history-strip.test.tsx`

Expected: PASS with 0 failures.

Run: `npx eslint app/workspace-history-strip.tsx app/page.tsx tests/agent/workspace-history-strip.test.tsx && git diff --check`

Expected: exit 0.

- [ ] **Step 6: Commit only this slice**

```powershell
git add app/workspace-history-strip.tsx app/page.tsx app/warm-theme.css tests/agent/workspace-history-strip.test.tsx
git commit -m "feat: collapse historical analysis workspaces"
```
