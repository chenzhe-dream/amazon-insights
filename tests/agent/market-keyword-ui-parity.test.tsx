import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketKeywordFactsReport,MarketKeywordRevisionReport} from '../../app/market-keyword-report';
import {keywordAnnualVolume} from '../../app/market-keyword-table';
import {MarketKeywordSection} from '../../app/market-keyword-section';
import {keywordPageRun} from './helpers/market-keyword-page-fixture';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {keywordClusterExpression} from '../../app/market-keyword-result-view-model';
test('keyword primary report preserves original columns and distinguishes unknown reference month from undated source values',()=>{
 const facts=keywordPageRun().run.facts!;
 const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={facts}/>);
 for(const label of ['关键词分类','热度趋势','季节','周搜索排名','月搜索量','CPC 建议','模糊搜索关键词','每页']) assert.ok(html.includes(label),`missing original control: ${label}`);
 assert.ok(html.includes('参考月未知'));
 assert.ok(html.includes('来源未注明月份'));
 assert.ok(!html.includes('均衡'));
});
test('keyword query preserves site chips and core-name entry with supported marketplace constraint',()=>{
 const html=renderToStaticMarkup(<MarketKeywordSection selection={{nodeIdPath:'1:2',fromMonth:'2026-07',toMonth:'2026-08'}} onSelectionChange={()=>{}} maxMonth="2026-08"/>);
 for(const label of ['选择站点','产品核心名','英国站','日本站','收藏']) assert.ok(html.includes(label),`missing original query control: ${label}`);
 assert.doesNotMatch(html,/<button[^>]*disabled=""[^>]*>英国站<\/button>/);
});

test('empty keyword reports keep every report area without claiming zero demand or completed classification',()=>{
 const facts=keywordPageRun().run.facts!;facts.members=[];
 for(const emptyReason of ['关键词采集失败：来源或模型数据校验未通过。','关键词仍在采集中。','来源本次未返回关键词。']){
  const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={facts} semanticSkipped emptyReason={emptyReason}/>);
  for(const label of ['分析未生成','五维综合结论','W1 产品','W2 人群','W3 场景','W4 功能属性','W5 需求变化','需求簇合成',emptyReason])assert.ok(html.includes(label),label);
  assert.ok(!html.includes('已识别 0 个需求簇'));assert.ok(!html.includes('月搜索量合计 0'));assert.ok(!html.includes('规则自动分类'));
 }
});

test('independent keyword category is visible before optional collection settings', () => {
 const html=renderToStaticMarkup(<MarketKeywordSection selection={{nodeIdPath:'',fromMonth:'2026-07',toMonth:'2026-08'}} onSelectionChange={()=>{}} maxMonth="2026-08"/>);
 const query=html.slice(0,html.indexOf('market-insights-query-options'));
 assert.match(query,/id="market-keyword-node"/);
 assert.match(query,/类目节点或路径/);
});

test('keyword report restores five-dimension and demand synthesis areas even when evidence is unavailable',()=>{
 const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={keywordPageRun().run.facts!}/>);
 for(const label of ['五维综合结论','W1 产品','W2 人群','W3 场景','W4 功能属性','W5 需求变化','需求簇合成'])assert.ok(html.includes(label),`missing demand area: ${label}`);
});

test('keyword result restores visible W5 facts, cluster expression and taxonomy without inventing conclusions',()=>{
 const {response}=keywordRuleFixture(),{facts,reconciliation,ruleReport}=response.run;
 const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={facts!} reconciliation={reconciliation!} ruleReport={ruleReport!}/>);
 assert.match(html,/aria-label="W5 需求变化明细"/);
 assert.match(html.slice(html.indexOf('aria-label="W5 需求变化明细"'),html.indexOf('需求簇合成')),/样本占比/);
 assert.match(html,/较3个月前/);
 assert.match(html,/W1（/);
 assert.match(html,/关键词含义分类标准/);
 assert.match(html,/综合结论尚未提供/);
 assert.match(html,/12 类含义分类尚未提供/);
 assert.ok(html.indexOf('W5 需求变化明细')<html.indexOf('需求簇合成'));
 const empty=renderToStaticMarkup(<MarketKeywordFactsReport facts={keywordPageRun().run.facts!}/>);
 assert.match(empty,/关键词含义分类标准/);
 assert.match(empty,/W5 规则报告尚未取得/);
 assert.doesNotMatch(empty,/W1（[^）]*undefined/);
});

test('rules-only keyword report keeps W5 and labels W1–W4 as awaiting classification, not a running model',()=>{
 const {response}=keywordRuleFixture();
 const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={response.run.facts!} ruleReport={response.run.ruleReport!} semanticSkipped/>);
 assert.match(html,/W5 需求变化明细/);
 assert.match(html,/W1–W4 待人工分类/);
 assert.match(html,/语义分析未启用/);
 assert.match(html,/保存目录未用于自动分类/);
 assert.doesNotMatch(html,/语义证据待补齐|跨批语义结果尚未可用|模型原始建议/);
 assert.doesNotMatch(html,/W1 语义建议，待校对/);
 const historical=renderToStaticMarkup(<MarketKeywordFactsReport facts={response.run.facts!}/>);
 assert.match(historical,/模型原始建议/);
 const manual=renderToStaticMarkup(<MarketKeywordRevisionReport catalog={keywordRuleFixture().revision.catalog} semanticSkipped/>);
 assert.match(manual,/人工分类与规则统计独立保存/);
 assert.doesNotMatch(manual,/人工分类与模型原始建议独立保存/);
});

test('cluster expression selects only ready saved member labels and preserves partially unknown dimensions',()=>{
 const {response}=keywordRuleFixture(),report=response.run.reconciliation!,ids=response.run.facts!.members.map(m=>m.keywordId);
 assert.equal(keywordClusterExpression(ids,report),'W1（灯具） + W2（未知） + W3（未知） + W4（未知）');
 assert.match(keywordClusterExpression([...ids,'missing-member'],report),/W1（灯具；部分原词未知）/);
 assert.equal(keywordClusterExpression(ids,{...report,status:'pending'}),'W1（未知） + W2（未知） + W3（未知） + W4（未知）');
 assert.equal(keywordClusterExpression(['another-cluster'],report),'W1（未知） + W2（未知） + W3（未知） + W4（未知）');
});


test('annual display requires twelve known calendar months and preserves zero',()=>{
 const member=keywordPageRun().run.facts!.members[0];
 assert.equal(keywordAnnualVolume(member,'2026'),null);
 const missing={value:null,reason:'missing' as const},growth={value:null,reason:'missing-current' as const,baselineMonth:'2025-01',baselineValue:null,formulaVersion:'calendar-month-growth/v1' as const};
 member.trend.months=Array.from({length:12},(_,i)=>({month:`2026-${String(i+1).padStart(2,'0')}`,searchVolume:{value:0,reason:null},searchRank:missing,recommendedBid:missing,yoyGrowth:growth,recentGrowth:growth}));
 assert.equal(keywordAnnualVolume(member,'2026'),0);
 member.trend.months[5].searchVolume=missing;
 assert.equal(keywordAnnualVolume(member,'2026'),null);
});

test('keyword monthly trend uses reference blue line and breaks at missing calendar months',()=>{
 const facts=keywordPageRun().run.facts!,missing={value:null,reason:'missing' as const},growth={value:null,reason:'missing-current' as const,baselineMonth:'2025-01',baselineValue:null,formulaVersion:'calendar-month-growth/v1' as const};
 facts.members=facts.members.slice(0,1);
 facts.members[0].trend.months=[{month:'2026-01',searchVolume:{value:10,reason:null}},{month:'2026-03',searchVolume:{value:30,reason:null}},{month:'2026-04',searchVolume:{value:40,reason:null}}].map(p=>({...p,searchRank:missing,recommendedBid:missing,yoyGrowth:growth,recentGrowth:growth}));
 const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={facts}/>);
 assert.equal((html.match(/<line /g)??[]).length,1,'January to March must remain disconnected');
 assert.ok(html.includes('stroke="#2563eb"'));
 assert.ok(html.includes('当前页月份、来源指标与证据'));
});
