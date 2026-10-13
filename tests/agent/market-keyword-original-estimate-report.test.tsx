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

test('Who without audience evidence never assumes family users in current or saved reports',()=>{
 const facts=structuredClone(keywordRuleFixture().response.run.facts!);
 facts.members.forEach((member,i)=>{member.keyword=i?'floor lamp for bedroom':'floor lamp';member.pageMetrics.monthlySearchVolume={value:100,reason:null};});
 const {factsId,...basis}=facts;void factsId;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const estimate=buildKeywordOriginalEstimate({facts,productSeed:'floor lamp'});
 assert.equal(estimate.report.dimensions.w2.rows.length,0);
 const before=digest(estimate),html=renderToStaticMarkup(<MarketKeywordOriginalEstimateReport estimate={estimate}/>);
 assert.match(html,/人群证据不足/);assert.doesNotMatch(html,/默认面向家庭|默认家庭通用/);assert.equal(digest(estimate),before);
});

test('Who retains explicit audience evidence and qualifies sparse audience signals',()=>{
 for(const volume of [100,1]){
  const facts=structuredClone(keywordRuleFixture().response.run.facts!);
  facts.members.forEach((member,i)=>{member.keyword=i?'floor lamp for kids':'floor lamp';member.pageMetrics.monthlySearchVolume={value:i?volume:100,reason:null};});
  const {factsId,...basis}=facts;void factsId;facts.factsId=`market-keyword-facts:${digest(basis)}`;
  const estimate=buildKeywordOriginalEstimate({facts,productSeed:'floor lamp'});
  assert.ok(estimate.report.dimensions.w2.rows.some(row=>row.label==='儿童'));
  const html=renderToStaticMarkup(<MarketKeywordOriginalEstimateReport estimate={estimate}/>);
  assert.match(html,/floor lamp for kids/);assert.doesNotMatch(html,/默认家庭通用/);
  assert.ok(html.includes(volume===1?'人群证据不足':'人群信号最强'));
 }
});
