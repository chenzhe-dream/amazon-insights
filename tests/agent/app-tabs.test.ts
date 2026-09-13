import assert from "node:assert/strict";
import test from "node:test";

import { buildAppTabHref, isAppTab, tabFromParam } from "../../app/lib/app-tabs";

test("retired and unknown tab parameters fall back to the valid overview tab", () => {
  assert.equal(tabFromParam("overview-aplus"), "overview");
  assert.equal(tabFromParam("retired-bookmark"), "overview");
  assert.equal(tabFromParam(null), "overview");
  assert.equal(isAppTab("overview"), true);
});

test("market navigation leaves the ASIN workspace and drops unrelated execution parameters", () => {
  const current = new URLSearchParams("tab=voc&sub=review&asins=B012345678&project=p1&run=r1&syncJob=j1&vocRun=v1&webArtifact=artifact");
  const url = new URL(buildAppTabHref("market-overview", current, "/p/floor-lamps"), "http://localhost");
  assert.equal(url.pathname, "/");
  assert.deepEqual([...url.searchParams], [["tab", "market-overview"], ["webArtifact", "artifact"]]);
  assert.equal(current.get("syncJob"), "j1");
});

test("existing ASIN navigation preserves its project and execution scope", () => {
  assert.equal(buildAppTabHref("voc", new URLSearchParams("run=r1&syncJob=j1&sub=old"), "/p/demo"), "/p/demo?run=r1&syncJob=j1&tab=voc");
  assert.equal(buildAppTabHref("overview", new URLSearchParams("tab=voc")), "/");
});

test("market overview is an independent supported tab; unfinished modules stay unavailable", () => {
  assert.equal(tabFromParam("market-overview"), "market-overview");
  assert.equal(isAppTab("market-overview"), true);
  assert.equal(isAppTab("market-structure"), false);
  assert.equal(isAppTab("market-traffic"), false);
  assert.equal(isAppTab("market-review-insight"), false);
});
