import assert from 'node:assert/strict';
import test from 'node:test';
import type {MarketModuleRunView} from '../../server/db/market-module-execution-repository';
import {canCompleteMarketThemeRun} from '../../server/domain/market-research/customer-theme-run-status';
import {themeEntry} from './helpers/market-theme-page-fixture';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

function fixture(){
  const entry=themeEntry(),r=entry.report;r.status='complete';r.dataReady=true;r.semanticsReady=true;r.reasons=[];
  Object.assign(r.counts,{requestedCount:2,selectedCount:2,successfulCount:2,failedCount:0,mappedMemberCount:2,unknownCount:0});
  const {reportHash:_,...body}=r;r.reportHash=digest(body);
  const step={id:'report-step',stepKey:'current-report',kind:'report',status:'succeeded',latestAttemptId:entry.attemptId};
  const view={run:{id:r.moduleRunId,scope:r.scope,versions:r.versions,status:'partial',moduleKind:'customer-themes',latestReportAttemptId:entry.attemptId},
    steps:[step],attempts:[{id:entry.attemptId,stepId:step.id,status:'succeeded',output:r}]} as unknown as MarketModuleRunView;
  return {view,r,keys:['current-report']};
}
test('only the current published complete report completes the module',()=>{
  const f=fixture();assert.equal(canCompleteMarketThemeRun(f.view,f.keys),true);
  f.view.run.latestReportAttemptId=null;assert.equal(canCompleteMarketThemeRun(f.view,f.keys),false);
});
test('old reports and historical failures do not decide the new frontier',()=>{
  const f=fixture();assert.equal(canCompleteMarketThemeRun(f.view,['next-report']),false);
  f.view.steps.push({...f.view.steps[0],id:'old',stepKey:'old-report',status:'failed',latestAttemptId:'old-attempt'});
  assert.equal(canCompleteMarketThemeRun(f.view,f.keys),true);
  assert.equal(canCompleteMarketThemeRun(f.view,[...f.keys,'old-report']),false);
});
test('partial, empty, pending, missing and untrusted reports never become success',()=>{
  for(const status of ['partial','no-data'] as const){const f=fixture();f.r.status=status;const {reportHash:_,...body}=f.r;f.r.reportHash=digest(body);assert.equal(canCompleteMarketThemeRun(f.view,f.keys),false);}
  for(const status of ['queued','running','failed','cancelled','empty'] as const){const f=fixture();f.view.steps[0].status=status;assert.equal(canCompleteMarketThemeRun(f.view,f.keys),false);}
  const f=fixture();assert.equal(canCompleteMarketThemeRun(f.view,[...f.keys,'not-created']),false);
  f.r.reportHash='f'.repeat(64);assert.equal(canCompleteMarketThemeRun(f.view,f.keys),false);
});
