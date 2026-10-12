import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import test from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import type {CompetitorOverviewSnapshotProps} from "../../app/project-report-views/competitor-overview";

registerHooks({load(url, context, nextLoad) {
  if (url.endsWith(".css")) return {format: "module", source: "", shortCircuit: true};
  return nextLoad(url, context);
}});
const {CompetitorOverviewSnapshotView} = await import("../../app/project-report-views/competitor-overview");

test("overview snapshot retains the native matrix and complete cached selling points", () => {
  const asin = "B012345678";
  const props = {
    products: [{asin, brand: "Test", image: "", title: "Test", price: 49.99, sales: 100, rating: 4.5, reviews: 12, rank: 100, subRank: null, rankCategory: "Lamps", subRankCategory: "—", buyBoxSeller: "Test", fulfillment: "FBA", packageSize: "10 cm", packageWeight: "1 kg", specifications: ["Metal", "Warm light"], launch: "2024", format: "Color", variants: "2", history: [], prices: [], ranks: [], variantShare: [], variantDetails: [], sellingPoints: [], strengths: [], weaknesses: [], unmet: [], scenarios: [], audiences: [], keywords: [], traffic: {natural: 0, sponsored: 0, recommendation: 0}, synced: true}],
    market: "US", slugParam: "test", salesTrendByAsin: {}, ratingByAsin: {}, fbaFeeByAsin: {}, childSalesByAsin: {}, priceStrategyByAsin: {}, categoryTrendByNode: {},
    sellingTranslationsByAsin: {[asin]: {asin, sourceHash: "hash", state: "ready", points: ["Translated one", "Translated two"], original: ["Original one", "Original two"], sourceComplete: true, message: null}},
  } as unknown as CompetitorOverviewSnapshotProps;
  const html = renderToStaticMarkup(<CompetitorOverviewSnapshotView {...props} />);
  for (const content of ["compare-matrix", "当前售价", "$49.99", "Warm light", "价格策略分析", "Translated one", "Translated two", "Original one", "Original two"]) assert.ok(html.includes(content), content);
  assert.match(html, /<details[^>]*><summary>查看原文<\/summary>/);
  assert.match(html, /<details[^>]*open=""[^>]*><summary>月销量<\/summary>/);
  for (const label of ["月销售额", "历史价格", "大类 BSR", "竞品参数总览", "竞品历史数据追踪"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /<button|<script|正在准备中文卖点/);

  const unavailable = renderToStaticMarkup(<CompetitorOverviewSnapshotView {...props} sellingTranslationsByAsin={{[asin]: {asin, sourceHash: "hash", state: "unavailable", points: [], original: ["Retained source text"], sourceComplete: false, message: "Translation unavailable"}}}/>);
  assert.ok(unavailable.includes("Retained source text"));
  assert.ok(unavailable.includes("Translation unavailable"));

  const withChildren = renderToStaticMarkup(<CompetitorOverviewSnapshotView {...props} childSalesByAsin={{[asin]: Array.from({length: 7}, (_, index) => ({asin: `B00000000${index}`, variant: `Variant ${index}`, sales: 70 - index, observedAt: "2026-09-01"}))}}/>);
  assert.match(withChildren, /查看其余 2 个子体/);
  assert.ok(withChildren.includes("Variant 6"));

  const months = Array.from({length: 14}, (_, index) => ({month: `2025-${String(index + 1).padStart(2, "0")}`, value: index + 1}));
  const withHistory = renderToStaticMarkup(<CompetitorOverviewSnapshotView {...props} salesTrendByAsin={{[asin]: {asin, marketplace: "US", fetchedAt: "2026-09-01", status: "ready", volume: months, amount: months, price: months, rank: months}}}/>);
  assert.match(withHistory, /<summary>全部月份明细<\/summary>/);
  assert.ok(withHistory.includes("2025-01"), "first source month remains available beyond chart's 12-month window");

  const category = (nodeId: string, categoryName: string) => ({nodeId, categoryName, topCategory: "Lighting", sourceAsin: asin, asins: [asin], marketplace: "US", fetchedAt: "2026-09-01", status: "ready" as const, volume: [{month: "2026-08", value: 100}], amount: [{month: "2026-08", value: 300}], avgPrice: [{month: "2026-08", value: 3}], listingMonopoly: [{month: "2026-07", value: 12.34}], brandMonopoly: [{month: "2026-08", value: 23.45}], sellerMonopoly: [{month: "2026-08", value: 34.56}]});
  const withCategories = renderToStaticMarkup(<CompetitorOverviewSnapshotView {...props} categoryTrendByNode={{nodeA: category("nodeA", "Lamps A"), nodeB: category("nodeB", "Lamps B")}}/>);
  assert.ok(withCategories.includes("Lamps A"));
  assert.ok(withCategories.includes("Lamps B"));
  assert.match(withCategories, /<summary>全部月份明细<\/summary>/);
  assert.ok(withCategories.includes("2026-07"), "a monopoly-only month remains available");
  assert.ok(withCategories.includes("Listing 垄断系数"));
  assert.doesNotMatch(withCategories, /<select/);
});

test('source daily panel renders exact values and missing observations without monthly inference', async()=>{
  const module = await import('../../app/project-report-views/competitor-overview');
  assert.equal(typeof module.SourceDailyObservations,'function');
  const html=renderToStaticMarkup(<module.SourceDailyObservations products={[{asin:'B0BWCQHCWX',brand:'Test'}] as any} salesTrendByAsin={{B0BWCQHCWX:{asin:'B0BWCQHCWX',marketplace:'US',fetchedAt:'2026-10-12',status:'empty',volume:[],amount:[],price:[],rank:[],dailyObservations:{volume:[{date:'2026-09-01',value:0},{date:'2026-09-03',value:12}],price:[{date:'2026-09-02',value:23}]}}}}/>);
  for(const text of ['来源日观测序列','2026-09-01','2026-09-02','2026-09-03','12','23','月度数据不可用','口径未确认','>0<','>—<']) assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/日销量|年销量|增长率/);
  assert.match(html, /销售额[^<]*<small>采集：未知<\/small>/);
});

test('saved B0B monthly response exposes all 25 source months in rendered records',async()=>{
  const {readFileSync}=await import('node:fs');
  const {buildSalesTrendRecord}=await import('../../scripts/build-sorftime-sales-trend.mjs');
  const {projectStageOutput}=await import('../../scripts/lib/sync-stage-output.mjs');
  const raw=JSON.parse(readFileSync(new URL('../fixtures/sorftime-b0b-monthly-trend.json',import.meta.url),'utf8'));
  const asin='B0BWCQHCWX';
  const record=buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',responses:{volume:raw}}) as import('../../app/sorftime-sales-trend-data').SorftimeSalesTrendRecord;
  const frozen=projectStageOutput('sales_trend',[asin],{readExport:()=>({[asin]:record})});
  assert.ok('data' in frozen);
  const html=renderToStaticMarkup(<CompetitorOverviewSnapshotView products={[{asin,brand:'Test',specifications:[],history:[],prices:[],ranks:[],variantShare:[],variantDetails:[],sellingPoints:[]}] as any} market='US' slugParam='test' salesTrendByAsin={frozen.data.trendByAsin as CompetitorOverviewSnapshotProps["salesTrendByAsin"]} ratingByAsin={{}} fbaFeeByAsin={{}} childSalesByAsin={{}} priceStrategyByAsin={{}} categoryTrendByNode={{}} sellingTranslationsByAsin={{}}/>);
  for(const point of record.volume) assert.ok(html.includes(`<th>${point.month}</th>`),point.month);
  assert.equal((html.match(/<th>202[456]-\d{2}<\/th>/g)??[]).length,25);
});
