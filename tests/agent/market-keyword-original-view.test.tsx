import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketKeywordFactsReport} from '../../app/market-keyword-report';
import {buildKeywordOriginalClassification} from '../../server/domain/market-research/keyword-original-classification';
import {buildMarketKeywordRuleReport} from '../../server/domain/market-research/keyword-rule-report';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
test('rules-only report automatically shows dimensions, taxonomy and demand clusters in existing cards',()=>{
 const facts=keywordRuleFixture().response.run.facts!,automaticClassification=buildKeywordOriginalClassification(facts,'lamp');
 const ruleReport=buildMarketKeywordRuleReport({facts,classification:{kind:'local',report:automaticClassification}});
 const html=renderToStaticMarkup(<MarketKeywordFactsReport facts={facts} semanticSkipped automaticClassification={automaticClassification} ruleReport={ruleReport}/>);
 assert.ok(html.includes('规则自动分类'));assert.ok(!html.includes('W1–W4 待人工分类'));
 assert.ok(html.includes('lamp · 通用'));assert.ok(html.includes('12 类含义分类'));
 assert.ok(!html.includes('当前尚无可用需求簇规则报告'));assert.ok(!html.includes('NaN'));
});
