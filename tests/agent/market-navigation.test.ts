import assert from "node:assert/strict";
import test from "node:test";
import { marketNavigation, marketScreenFromParam, marketViewFromParam, marketViewHref } from "../../app/lib/market-navigation";

test("market links preserve research scope and drop competitor execution scope", () => {
  const source = new URLSearchParams("tab=traffic&asins=B000000001&project=p&run=r&syncJob=j&marketNode=123:456&marketMonth=2026-08&marketFrom=2026-06&marketHead=20&marketNew=6&marketShapeNode=222&marketKeywordNode=333&marketThemeNode=444&overviewRun=o&shapeRun=s&keywordRun=k&themeRun=t&webArtifact=a");
  for (const item of marketNavigation) {
    const url = new URL(marketViewHref(item.view, source), "http://localhost");
    assert.equal(url.pathname, "/");
    assert.equal(marketScreenFromParam(url.searchParams.get("themeView")), item.view);
    for (const key of ["marketNode", "marketMonth", "marketFrom", "marketHead", "marketNew", "webArtifact"]) assert.equal(url.searchParams.get(key), source.get(key));
    for (const key of ["marketShapeNode", "marketKeywordNode", "marketThemeNode"]) assert.equal(url.searchParams.get(key), source.get(key));
    for (const key of ["overviewRun", "shapeRun", "keywordRun", "themeRun"]) assert.equal(url.searchParams.get(key), source.get(key));
    for (const key of ["asins", "project", "run", "syncJob"]) assert.equal(url.searchParams.has(key), false);
  }
  assert.equal(marketViewFromParam("unknown"), "overview");
  assert.equal(marketViewHref("overview", new URLSearchParams()), "/?tab=market-overview");
});

test("opening a fresh module keeps its category empty instead of copying the overview node", () => {
  const fromOverview = new URLSearchParams("tab=market-overview&marketNode=123456&marketMonth=2026-08");
  for (const [view, key] of [["shapes", "marketShapeNode"], ["keywords", "marketKeywordNode"], ["themes", "marketThemeNode"]] as const) {
    const url = new URL(marketViewHref(view, fromOverview), "http://localhost");
    assert.equal(url.searchParams.get(key), "");
  }
});

test('returning from a report keeps the directory on its category and module',()=>{
 const source=new URLSearchParams('themeView=shapes&marketNode=1:3405881&marketShapeNode=2:166423011');
 const back=new URL(marketViewHref('favorites',source),'http://localhost').searchParams;
 assert.equal(back.get('favoriteCategory'),'166423011');assert.equal(back.get('favoriteModule'),'shapes');
 const directory=new URLSearchParams('themeView=favorites&favoriteCategory=16184244011&favoriteModule=keywords&favoritePage=2');
 const retained=new URL(marketViewHref('favorites',directory),'http://localhost').searchParams;
 for(const key of ['favoriteCategory','favoriteModule','favoritePage'])assert.equal(retained.get(key),directory.get(key));
});
