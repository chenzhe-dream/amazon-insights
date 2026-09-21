import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketOverviewRuleExplanation} from '../../app/market-overview-rule-explanation';
import {overviewDetails} from './helpers/market-overview-page-fixture';

test('overview operator rules reflect saved formula references and never reinterpret unknown versions',()=>{
 const detail=overviewDetails(),semantic=detail.semantic!;
 assert.equal(semantic.task,'market-overview-explanation');if(semantic.task!=='market-overview-explanation')return;
 semantic.metrics[0].formulaVersion='overview-response-group-share/v1';
 semantic.metrics[0].numeratorRef='row/units';semantic.metrics[0].denominatorRef='group/units';
 const before=JSON.stringify(detail),html=renderToStaticMarkup(<MarketOverviewRuleExplanation entry={detail.entry} semantic={semantic}/>);
 assert.match(html,/本报告的分析规则/);assert.match(html,/同一返回分组/);assert.match(html,/row\/units/);assert.match(html,/group\/units/);assert.match(html,/不补零/);
 assert.equal(JSON.stringify(detail),before);
 semantic.metrics[0].formulaVersion='future/formula-v99';
 const future=renderToStaticMarkup(<MarketOverviewRuleExplanation entry={detail.entry} semantic={semantic}/>);
 assert.match(future,/该公式版本的说明尚未收录/);assert.doesNotMatch(future,/同一返回分组/);
});
