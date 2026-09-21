import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KeywordDemandSection } from "../../app/keyword-demand-section";
import type { KeywordDemandSources } from "../../app/keyword-demand-analysis";

test("keyword insight renders pending and missing evidence without false-need labels", () => {
  const products = Array.from({ length: 4 }, (_, index) => ({ asin: `B0UITEST0${index}`, brand: "Fixture", title: "Candle warmer lamp" }));
  const words: Array<[string, number | null, number]> = [
    ["unit timer candle warmer lamp", 166151, 4],
    ["unit adjustable height candle warmer lamp", 8772, 1],
    ["unit candle warmer with timer", 16070, 2],
    ["unit dimmable candle warmer lamp", 8212, 2],
    ["unit dimmable lamp missing search", null, 4],
  ];
  const sources: KeywordDemandSources = {
    enrichmentByKeyword: {},
    analysisByAsin: Object.fromEntries(products.map((product, index) => [product.asin, {
      asin: product.asin, marketplace: "US", fetchedAt: "2026-09-15", status: "ready",
      totalKeywordsInPeriod: 5, topKeywordsAnalyzed: 5,
      keywords: words.filter(([, , coverage]) => index < coverage).map(([keyword, searchVolume]) => ({
        keyword, searchVolume, trafficShare: 10, abaRank: null, cpcMedian: null, cpcLow: null,
        cpcHigh: null, naturalRatio: null, trafficDependency: null, organicRank: null,
        rankEvolution: null, keywordHealth: null, top3ClickShare: null, top3ConversionShare: null,
        clickConversionRate: null,
      })),
    }])),
  };
  const html = renderToStaticMarkup(createElement(KeywordDemandSection, { products, sources, mode: "insight" }));
  assert.match(html, /功能搜索信号/);
  assert.match(html, /tier-pending[^]*?待验证/);
  assert.match(html, /数据不足/);
  assert.match(html, /关键词覆盖竞品/);
  assert.doesNotMatch(html, /伪需求|最关注功能|原则上不单独配置/);
});
