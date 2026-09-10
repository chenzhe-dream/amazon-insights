import assert from "node:assert/strict";
import test from "node:test";
import { appTabIds } from "../../app/lib/app-tabs";
import {
  groupIdForTab,
  isNavGroup,
  navigationEntries,
} from "../../app/features/shell/navigation";

test("navigation assigns grouped and standalone tabs to the same visible destinations", () => {
  assert.equal(groupIdForTab("overview-images"), "overview-group");
  assert.equal(groupIdForTab("voc-positioning"), "voc-group");
  assert.equal(groupIdForTab("keyword-insight"), "keywords-group");
  assert.equal(groupIdForTab("traffic-promo"), "projects-group");
  assert.equal(groupIdForTab("definition"), null);
  assert.equal(groupIdForTab("checklist"), null);
  assert.equal(groupIdForTab("traffic"), null);
});

test("navigation exposes every valid tab exactly once", () => {
  const leafIds = navigationEntries.flatMap(entry =>
    isNavGroup(entry) ? entry.children.map(child => child.id) : [entry.id],
  );

  assert.equal(new Set(leafIds).size, leafIds.length);
  assert.deepEqual([...leafIds].sort(), [...appTabIds].sort());
});
