import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketKeywordFactsReport,MarketKeywordRevisionReport} from '../../app/market-keyword-report';
import {buildKeywordOriginalEstimate} from '../../server/domain/market-research/keyword-original-estimate';
import {MarketKeywordRunResponseSchema} from '../../shared/market-keyword-public-contracts';
import {MarketKeywordRevisionEntrySchema} from '../../shared/market-keyword-revision-contracts';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
test('live report shows archive estimates as main output while preserving source and strict report',()=>{
 const {response}=keywordRuleFixture(),facts=response.run.facts!,originalEstimate=buildKeywordOriginalEstimate({facts,productSeed:'lamp'});
 response.run.originalEstimate=originalEstimate;
 assert.equal(MarketKeywordRunResponseSchema.safeParse(response).success,true);
 const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={facts} semanticSkipped ruleReport={response.run.ruleReport} originalEstimate={originalEstimate}/>);
 assert.match(html,/原版估算评分/);assert.match(html,/S3、S5 固定 50/);assert.match(html,/统计月份未注明/);
 assert.match(html,/严格数据核对/);assert.match(html,/产品开发方向/);assert.match(html,/验证优先级/);
 assert.match(html,/关键词事实明细/);assert.match(html,/class="card launch-block/);
});
test('saved manual report uses its own estimate and stale estimate is not displayed',()=>{
 const {revision}=keywordRuleFixture(),originalEstimate=buildKeywordOriginalEstimate({facts:revision.catalog.facts,productSeed:'lamp',revision:revision.catalog});
 assert.equal(MarketKeywordRevisionEntrySchema.safeParse({...revision,originalEstimate}).success,true);
 const html=renderToStaticMarkup(<MarketKeywordRevisionReport {...revision} originalEstimate={originalEstimate}/>);
 assert.match(html,/原版估算评分/);assert.match(html,/人工灯具组/);
 const stale=renderToStaticMarkup(<MarketKeywordRevisionReport {...revision} originalEstimate={{...originalEstimate,factsId:'stale'}}/>);
 assert.doesNotMatch(stale,/原版估算评分/);
});
