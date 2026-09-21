import assert from "node:assert/strict";
import test from "node:test";
import { marketNavigation, marketViewFromParam, marketViewHref } from "../../app/lib/market-navigation";

test("market links preserve research scope and drop competitor execution scope", () => {
  const source = new URLSearchParams("tab=traffic&asins=B000000001&project=p&run=r&syncJob=j&marketNode=123:456&marketMonth=2026-08&marketFrom=2026-06&marketHead=20&marketNew=6&webArtifact=a");
  for (const item of marketNavigation) {
    const url = new URL(marketViewHref(item.view, source), "http://localhost");
    assert.equal(url.pathname, "/");
    assert.equal(marketViewFromParam(url.searchParams.get("themeView")), item.view);
    for (const key of ["marketNode", "marketMonth", "marketFrom", "marketHead", "marketNew", "webArtifact"]) assert.equal(url.searchParams.get(key), source.get(key));
    for (const key of ["asins", "project", "run", "syncJob"]) assert.equal(url.searchParams.has(key), false);
  }
  assert.equal(marketViewFromParam("unknown"), "overview");
  assert.equal(marketViewHref("overview", new URLSearchParams()), "/?tab=market-overview");
});
