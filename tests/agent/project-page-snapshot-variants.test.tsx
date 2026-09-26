import assert from "node:assert/strict";
import test from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import {PageSnapshotVariants} from "../../app/project-export/page-snapshot-variants";
import {readVariantsSnapshot} from "../../app/project-export/read-variants-export";
import {RuntimeAnalysisDataSnapshotSchema} from "../../app/lib/runtime-analysis-data";
import {getXydcOrderWindow} from "../../shared/xydc-order-summary";
import type {XydcVariantFamily} from "../../shared/xydc-variant-contract";
import type {XydcOrderSnapshot} from "../../shared/xydc-order-contract";

const capturedAt = "2026-09-24T10:00:00.000Z";
const window = getXydcOrderWindow(new Date(capturedAt));
const children = Array.from({length: 5}, (_, index) => `B00000001${index}`);
const family: XydcVariantFamily = {inputAsin: "B000000001", country: "US", parentAsin: "B000000010", dimensions: ["Color"],
  children: children.map((asin, index) => ({asin, attributes: [{dimension: "Color", value: index ? "Blue" : "Red", labelZh: index ? "蓝色" : "红色"}], title: `Child ${index}`, imageUrl: null, price: 10 + index, currency: "USD", stars: null, productPageRatings: null, listingDate: null, infoStatus: "ready"})),
  sourceUpdatedAt: capturedAt, fetchedAt: capturedAt, status: "ready", reasonCode: null, cacheState: "fresh"};
const orders: XydcOrderSnapshot = {version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: family.parentAsin, childAsins: children,
  window, children: children.map((asin, index) => ({asin, fetchedAt: capturedAt, reasonCode: index === 4 ? "PARTIAL_DATA" : null,
    trends: window.months.filter((_, month) => index !== 4 || month !== 0).map((date, month) => ({date, orders: index === 0 && month === 0 ? 0 : index + 1}))})),
  sourceUpdatedAt: capturedAt, fetchedAt: capturedAt, cacheState: "fresh", reasonCode: "PARTIAL_DATA"};

test("variants snapshot reuses order cards and retains every child and cached month", () => {
  const html = renderToStaticMarkup(<PageSnapshotVariants products={[{asin: family.inputAsin, brand: "Brand", title: "Fixture lamp", image: ""}]} families={[family]} orderFamilies={[orders]} market={{label: "美国站", domain: "www.amazon.com"}} capturedAt={capturedAt} progress={null}/>);
  for (const value of ["xydc-order-card", "父体订单量份额与12个月趋势", "红色", children[4]!, window.startMonth, window.endMonth, "缺失", "未披露"]) assert.ok(html.includes(value), value);
  assert.match(html, /<details[^>]*><summary>查看全部 5 个子体与月度趋势<\/summary>/);
  assert.doesNotMatch(html, /<button|<select|role="dialog"|xydc-annual-inspection/);
  assert.ok(html.includes("USD 14.00"), "the fifth child retains its cached price in the full detail");
  assert.match(html, /title="2025-09 · B000000011 · 蓝色 · 2\+ · 占当月已披露订单 22\.22%"/);
  assert.match(html, /2 单<small> · 当月占比 22\.22%<\/small>/);

  const complete = {...orders, reasonCode: null, children: orders.children.map(child => ({...child, reasonCode: null,
    trends: window.months.map((date, index) => ({date, orders: index + 1}))}))} as XydcOrderSnapshot;
  const colored = renderToStaticMarkup(<PageSnapshotVariants products={[{asin: family.inputAsin, brand: "Brand", title: "Fixture lamp", image: ""}]} families={[family]} orderFamilies={[complete]} market={{label: "美国站", domain: "www.amazon.com"}} capturedAt={capturedAt} progress={null}/>);
  assert.match(colored, /xydc-order-share-segment/);
  assert.match(colored, /data-order-color="#ff0000"/);
});

test("variant source reader freezes scoped caches with strict read-only verification", async () => {
  const scope = {projectId: "project", organizationId: "org", marketplace: "US", asins: [family.inputAsin], sourceAsins: [family.inputAsin], currentRunId: null, version: null, capturedAt};
  const payload = RuntimeAnalysisDataSnapshotSchema.parse({
    catalog: [{asin: family.inputAsin, brand: "UNBOUND GLOBAL BRAND"}], keywords: {analysisByAsin: {}, enrichmentByKeyword: {}},
    reviews: {analysisByAsin: {}, ratingByAsin: {}}, salesTrend: {trendByAsin: {}}, fba: {feeByAsin: {}},
    listing: {contentByAsin: {}}, category: {trendByNode: {}}, childSales: {rowsByAsin: {}}, priceStrategy: {strategyByAsin: {}},
    imageRemarks: {remarksByAsin: {}, outcomesByAsin: {}}, variants: {families: [family]}, variantOrders: {families: [orders]},
    exportScope: {projectId: "project", organizationId: "org", marketplace: "US", asins: [family.inputAsin], readAt: capturedAt, contentHash: "a".repeat(64)},
  });
  let calls = 0;
  const source = await readVariantsSnapshot(scope, async (url, init) => {
    calls += 1;
    assert.match(url, /exportStrict=1/);
    assert.equal(init?.method, "GET");
    return Response.json(payload);
  });
  assert.equal(calls, 2);
  assert.equal(source.capturedAt, capturedAt);
  assert.equal(source.products[0]?.brand, "");
  assert.equal(source.families.length, 1);
  assert.equal(source.orderFamilies.length, 1);
  const wrongCatalog = {marketplace: "US", catalog: [{asin: family.inputAsin, marketplace: "UK", brand: "WRONG"}], stageOutputs: {listing: {data: {contentByAsin: {}}}}} as never;
  await assert.rejects(readVariantsSnapshot({...scope, version: wrongCatalog}, async () => Response.json(payload)), /父体商品目录来源范围不匹配/);
  const wrongListing = {marketplace: "US", catalog: [], stageOutputs: {listing: {data: {contentByAsin: {[family.inputAsin]: {asin: "B000000099", mainImage: "https://example.com/wrong.jpg"}}}}}} as never;
  await assert.rejects(readVariantsSnapshot({...scope, version: wrongListing}, async () => Response.json(payload)), /Listing来源范围不匹配/);
  await assert.rejects(readVariantsSnapshot(scope, async () => Response.json({...payload, variants: {families: [{...family, country: "UK"}]}})), /来源范围/);
  let unstable = 0;
  await assert.rejects(readVariantsSnapshot(scope, async () => Response.json({...payload, variants: {families: [{...family, children: family.children.map(child => ({...child, attributes: [{...child.attributes[0]!, labelZh: ++unstable === 1 ? "红色" : "深红色"}]}))}]}})), /缓存正在变化/);
});
