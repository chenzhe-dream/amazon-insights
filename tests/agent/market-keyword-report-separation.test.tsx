import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as reports from '../../app/market-keyword-report';
import {buildKeywordOriginalEstimate} from '../../server/domain/market-research/keyword-original-estimate';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';

test('business report keeps original results and collapses optional scoring, with no technical evidence',()=>{
 const {response}=keywordRuleFixture(),facts=response.run.facts!;
 const originalEstimate=buildKeywordOriginalEstimate({facts,productSeed:'lamp'});
 const html=renderToStaticMarkup(<reports.MarketKeywordFactsReport facts={facts} originalEstimate={originalEstimate} ruleReport={response.run.ruleReport} semanticSkipped/>);
 assert.match(html,/五维综合结论/);assert.match(html,/需求簇合成/);
 assert.match(html,/<details[^>]*><summary>评分与开发建议<\/summary>/);
 assert.doesNotMatch(html,/事实版本与来源截止时间|当前页月份、来源指标与证据|严格数据核对|原始词池快照|模型原始建议/);
 assert.doesNotMatch(html,new RegExp(facts.factsId));
 assert.match(html,/S3、S5 固定 50/);assert.match(html,/统计月份未注明/);
});

test('audit report separately retains source facts, provenance and strict diagnostics',()=>{
 const {response}=keywordRuleFixture(),facts=response.run.facts!;
 const Audit=(reports as any).MarketKeywordAuditReport;
 assert.equal(typeof Audit,'function');
 const html=renderToStaticMarkup(<Audit facts={facts} ruleReport={response.run.ruleReport} semanticSkipped/>);
 assert.match(html,/事实版本与来源截止时间/);assert.match(html,/月份、来源指标与证据/);
 assert.match(html,/严格数据核对/);assert.ok(html.includes(facts.factsId));
 assert.doesNotMatch(html,/五维综合结论/);
});

test('manual saved reports only expose technical identity when audit is explicitly enabled',()=>{
 const {revision}=keywordRuleFixture();
 const normal=renderToStaticMarkup(<reports.MarketKeywordRevisionReport {...revision}/>);
 assert.match(normal,/人工关键词修订/);assert.match(normal,/需求簇统计/);
 assert.doesNotMatch(normal,/人工版本与事实基线|父版本：|作者：|原始词池快照/);
 const admin=renderToStaticMarkup(React.createElement(reports.MarketKeywordRevisionReport,{...revision,showAuditDetails:true} as any));
 assert.match(admin,/人工版本与事实基线/);assert.match(admin,/作者：/);
});
