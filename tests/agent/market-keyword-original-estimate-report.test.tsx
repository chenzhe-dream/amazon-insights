import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketKeywordOriginalEstimateReport } from "../../app/market-keyword-original-estimate-report";
import { buildKeywordOriginalEstimate } from "../../server/domain/market-research/keyword-original-estimate";
import { keywordRuleFixture } from "./helpers/market-keyword-rule-fixture";
import { canonicalJsonSha256 as digest } from "../../server/runtime/model-request-accounting";

test("keyword report renders the 14 business outputs and explicit pending evidence", () => {
  const facts = structuredClone(keywordRuleFixture().response.run.facts!);
  facts.members.forEach(member => {
    member.pageMetrics.monthlySearchVolume = { value: 100, reason: null };
  });
  const { factsId: _factsId, ...basis } = facts;
  facts.factsId = `market-keyword-facts:${digest(basis)}`;
  const estimate = buildKeywordOriginalEstimate({ facts, productSeed: "lamp" });
  const html = renderToStaticMarkup(<MarketKeywordOriginalEstimateReport estimate={estimate} />);

  assert.match(html, /业务输出（14项）/);
  assert.match(html, /购买动机/);
  assert.match(html, /待验证/);
  assert.match(html, /缺少评论\/VOC购买动机证据/);
});
