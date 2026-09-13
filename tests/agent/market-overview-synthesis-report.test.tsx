import {synthesisDetails} from './helpers/market-overview-synthesis-page-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketOverviewReportSchema} from '../../shared/market-overview-report-contracts';
import {MarketOverviewSynthesis} from '../../app/market-overview-synthesis';
import {overviewAnalysisDetails} from './helpers/market-overview-page-fixture';


test('overview v2 accepts audited synthesis while v1 historical JSON remains exact',()=>{
 const old=overviewAnalysisDetails().entry.report;assert.deepEqual(MarketOverviewReportSchema.parse(old),old);
 const report=MarketOverviewReportSchema.parse(synthesisDetails().entry.report);
 assert.equal(report.reportVersion,'market-overview-report/v2');assert.equal(report.analysisStatus,'partial');
 assert.equal(MarketOverviewReportSchema.safeParse({...old,synthesis:{}}).success,false);
 assert.equal(MarketOverviewReportSchema.safeParse({...synthesisDetails().entry.report,windowStatus:'partial'}).success,false);
});

test('saved synthesis renders fixed zero and original gaps without HTML execution or missing-reference substitution',()=>{
 const detail=synthesisDetails(),report=MarketOverviewReportSchema.parse(detail.entry.report);
 if(report.reportVersion!=='market-overview-report/v2'||detail.semantic?.task!=='market-overview-explanation')throw Error('v2 required');
 report.synthesis.result.summary.statement.parts.unshift({kind:'text',text:'<img src=x onerror=alert()> '});
 const html=renderToStaticMarkup(<MarketOverviewSynthesis synthesis={report.synthesis} semantic={detail.semantic}/>);
 assert.match(html.replace(/<[^>]+>/g,''),/返回样本销量为0/);assert.match(html,/>0</);assert.match(html,/period-missing/);assert.match(html,/来源月份仍待确认/);
 assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.doesNotMatch(html,/完整综合判断仍待/);
 const missing=renderToStaticMarkup(<MarketOverviewSynthesis synthesis={report.synthesis} semantic={null}/>);assert.match(missing,/依据尚不可用/);
});
