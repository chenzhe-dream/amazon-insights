import assert from 'node:assert/strict';import test from 'node:test';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MarketOverviewOriginalSummary} from '../../app/market-overview-original-summary';import {projectMarketOverviewOriginalSynthesis} from '../../server/domain/market-research/overview-original-synthesis';
import {buildCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-score-readiness';
import {completeScoreFixture} from './helpers/overview-score-complete-fixture';
const scope={organizationId:'11111111-1111-4111-8111-111111111111',researchId:'22222222-2222-4222-8222-222222222222',marketplace:'US' as const,nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const};
test('empty evidence keeps the report and radar axes without a fabricated score, zero point or recommendation',()=>{
 const result=projectMarketOverviewOriginalSynthesis({scope,parameters:{headTopN:10,newProductMonths:6},sources:[]}),html=renderToStaticMarkup(<MarketOverviewOriginalSummary result={result}/>);
 assert.match(html,/原版市场概览总结/);assert.match(html,/市场机会六维雷达图/);assert.match(html,/数据不足/);
 assert.doesNotMatch(html,/缺失输入沿用原版默认规则|不建议准入|谨慎准入/);
 assert.doesNotMatch(html,/data-score-point=|data-score-polygon=/);
 assert.equal((html.match(/ss-market-synthesis-sections/g)??[]).length,1);
});
test('complete inputs keep score, radar and original conclusion; partial inputs show only supported axes',()=>{
 const {niche,report}=completeScoreFixture();const ready=buildCheckedOverviewSynthesis(niche,report);
 const render=(result:ReturnType<typeof buildCheckedOverviewSynthesis>)=>renderToStaticMarkup(<MarketOverviewOriginalSummary result={{version:6,...result,inputGaps:[],sourceRefs:[],originalAssumptions:[]}}/>);
 const full=render(ready);assert.match(full,/data-score-polygon=/);assert.equal((full.match(/data-score-point=/g)??[]).length,6);assert.ok(full.includes(ready.summary.gradeLabel!));
 niche.brandCrn=null;const partial=render(buildCheckedOverviewSynthesis(niche,report));assert.doesNotMatch(partial,/data-score-polygon=/);assert.equal((partial.match(/data-score-point=/g)??[]).length,5);assert.match(partial,/品牌集中度/);
});
