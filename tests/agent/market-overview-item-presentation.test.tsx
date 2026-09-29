import assert from 'node:assert/strict';import test from 'node:test';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {MarketOverviewOriginalSummary} from '../../app/market-overview-original-summary';
import {buildCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-score-readiness';
import {buildItemCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-item-scoring';
import {completeScoreFixture} from './helpers/overview-score-complete-fixture';
const wrap=(x:ReturnType<typeof buildCheckedOverviewSynthesis>)=>({version:6 as const,...x,inputGaps:[],sourceRefs:[],originalAssumptions:[]});
test('partial numeric scores are labelled and never form a complete radar',()=>{
 const {niche,report}=completeScoreFixture();report.productDemand!.pageViews=[];
 const result=wrap(buildCheckedOverviewSynthesis(niche,report)),review=wrap(buildItemCheckedOverviewSynthesis(niche,report));
 const html=renderToStaticMarkup(<MarketOverviewOriginalSummary result={result} review={review}/>);
 assert.match(html,/新版逐项复算/);assert.match(html,/此前逐维校验/);assert.match(html,/已确认/);assert.match(html,/评分项明细/);
 assert.doesNotMatch(html,/data-score-polygon=/);assert.equal((html.match(/data-score-point=/g)??[]).length,6);
 assert.match(html,/暂不评级/);
});
