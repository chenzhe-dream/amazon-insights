import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnalysisProject } from "../../app/features/projects/project-library-panel";
import { projectWorkspacePath } from "../../app/lib/workspace-url";
import {
  selectWorkspaceSections,
  WorkspaceHistoryStrip,
} from "../../app/features/projects/workspace-history-strip";

function project(index: number): AnalysisProject {
  const day = String(index + 1).padStart(2, "0");
  return {
    id: `p${index}`,
    name: `项目${index}`,
    slug: `p-${index}`,
    marketplace: "US",
    asins: ["B000000001", "B000000002", "B000000003"],
    majorCategory: null,
    categoryLabel: `品类${index}`,
    note: null,
    createdBy: null,
    createdAt: `2026-08-${day}T00:00:00.000Z`,
    updatedAt: `2026-08-${day}T00:00:00.000Z`,
  };
}

const fixtures = Array.from({ length: 8 }, (_, index) => project(index));

function renderStrip(
  workspaces: AnalysisProject[],
  currentProjectId: string | null,
): string {
  return renderToStaticMarkup(createElement(WorkspaceHistoryStrip, {
    workspaces,
    currentProjectId,
    buildHref: workspace => projectWorkspacePath(workspace.slug),
  }));
}

test("current workspace remains visible beside five most recent others", () => {
  const result = selectWorkspaceSections(fixtures, "p0", 5);

  assert.deepEqual(result.visible.map(item => item.id), ["p0", "p7", "p6", "p5", "p4", "p3"]);
  assert.deepEqual(result.history.map(item => item.id), ["p2", "p1"]);
});

test("workspaces without a current selection show only the five most recent", () => {
  const result = selectWorkspaceSections(fixtures, null, 5);

  assert.deepEqual(result.visible.map(item => item.id), ["p7", "p6", "p5", "p4", "p3"]);
  assert.deepEqual(result.history.map(item => item.id), ["p2", "p1", "p0"]);
});

test("a missing current workspace does not manufacture an active link", () => {
  const html = renderStrip(fixtures, "missing");

  assert.doesNotMatch(html, /workspace-chip active/);
});

test("zero through five workspaces do not create history", () => {
  for (let count = 0; count <= 5; count += 1) {
    const result = selectWorkspaceSections(fixtures.slice(0, count), null, 5);

    assert.equal(result.visible.length, count);
    assert.deepEqual(result.history, []);
  }
});

test("six workspaces move the oldest non-current workspace into history", () => {
  const result = selectWorkspaceSections(fixtures.slice(0, 6), "p5", 5);

  assert.deepEqual(result.visible.map(item => item.id), ["p5", "p4", "p3", "p2", "p1", "p0"]);
  assert.deepEqual(result.history, []);

  const withoutCurrent = selectWorkspaceSections(fixtures.slice(0, 6), null, 5);
  assert.deepEqual(withoutCurrent.history.map(item => item.id), ["p0"]);
});

test("equal update times use id ordering for deterministic sections", () => {
  const tied = [project(2), project(0), project(1)].map(item => ({
    ...item,
    updatedAt: "2026-08-01T00:00:00.000Z",
  }));

  const result = selectWorkspaceSections(tied, null, 2);

  assert.deepEqual(result.visible.map(item => item.id), ["p0", "p1"]);
  assert.deepEqual(result.history.map(item => item.id), ["p2"]);
});

test("history is collapsed without removing its links", () => {
  const html = renderStrip(fixtures, "p0");

  assert.match(html, /历史项目（2）/);
  assert.match(html, /<details/);
  assert.match(html, /href="\/p\/p-1"/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test("a workspace without a slug keeps the existing root href contract", () => {
  const html = renderStrip([{ ...project(0), slug: null }], "p0");

  assert.match(html, /href="\/"/);
});
