import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarCollapseToggle } from "../../app/sidebar-collapse-toggle";
import { useSidebarCollapse } from "../../app/lib/sidebar-preference";

test("sidebar preference defaults expanded, accepts only exact stored values, and survives unavailable storage", async () => {
  const moduleUrl = new URL("../../app/lib/sidebar-preference.ts", import.meta.url);
  assert.ok(existsSync(moduleUrl), "sidebar persistence helper is implemented");
  const { readSidebarCollapsed, saveSidebarCollapsed, SIDEBAR_PREFERENCE_KEY } = await import("../../app/lib/sidebar-preference");
  for (const value of [null, "false", "garbage", "{}", "1"]) assert.equal(readSidebarCollapsed({ getItem: () => value }), false);
  assert.equal(readSidebarCollapsed({ getItem: () => "true" }), true);
  assert.equal(readSidebarCollapsed({ getItem: () => { throw new Error("blocked"); } }), false);
  let stored = "";
  assert.equal(saveSidebarCollapsed({ setItem: (key, value) => { assert.equal(key, SIDEBAR_PREFERENCE_KEY); stored = value; } }, true), true);
  assert.equal(stored, "true");
  assert.equal(saveSidebarCollapsed({ setItem: () => { throw new Error("quota"); } }, false), false);
});
test("SSR starts expanded with a retained native keyboard button for hydration", () => {
  function Sidebar() { const { collapsed, toggle } = useSidebarCollapse(); return <SidebarCollapseToggle collapsed={collapsed} onToggle={toggle}/>; }
  const html = renderToStaticMarkup(<Sidebar/>);
  assert.match(html, /<button type="button"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="收起侧栏"/);
  assert.match(html, /aria-controls="primary-navigation"/);
});
