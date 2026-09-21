import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildFinalProductDefinition } from "../../app/final-product-definition";
import { LocalProductDefinitionSection } from "../../app/local-product-definition-section";
import { buildProductLaunchAnalysis, type ProductLaunchRuntimeSources } from "../../app/product-launch-analysis";

test("saved snapshot bypasses evaluation of current runtime sources", () => {
  const savedAnalysis = buildProductLaunchAnalysis([], { manualVocByAsin: {}, keywordDemand: null });
  const builtReport = buildFinalProductDefinition({
    categoryLabel: savedAnalysis.meta.categoryLabel,
    productCount: savedAnalysis.meta.productCount,
    dataMonth: savedAnalysis.meta.dataMonth,
    vocPositioning: savedAnalysis.vocPositioning,
    keyword: savedAnalysis.keywordConclusions,
    priceBand: "历史价格带",
    hasVocData: true,
  });
  const savedReport = { ...builtReport, meta: { ...builtReport.meta, categoryLabel: "历史快照类目" } };
  const throwingSources = new Proxy({} as ProductLaunchRuntimeSources, {
    get() { throw new Error("不应读取当前运行时来源"); },
  });

  const html = renderToStaticMarkup(createElement(LocalProductDefinitionSection, {
    products: [],
    sources: throwingSources,
    savedAnalysis,
    savedReport,
  }));

  assert.match(html, /历史快照类目/);
  assert.doesNotMatch(html, /不应读取当前运行时来源/);
});
