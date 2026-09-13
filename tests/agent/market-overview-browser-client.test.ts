import assert from 'node:assert/strict';
import test from 'node:test';
import {readOverviewRun,readOverviewDetails,createOverviewStudy} from '../../app/lib/market-overview-browser';
import {overviewRun,overviewRunId,overviewEntry,overviewDetails,overviewStudyId,overviewScope} from './helpers/market-overview-page-fixture';
test('overview client rejects cross-scope reports and altered history versions without accepting malformed identifiers',async()=>{
  const saved=globalThis.fetch;let calls=0,mode='run';globalThis.fetch=async(path,init)=>{calls++;assert.equal(init?.credentials,'same-origin');assert.match(String(path),/^\/api\/agent\/v1\/market-analysis\//);
    if(mode==='run'){const result=overviewRun();result.run.history[0].report.scope={...result.run.scope,nodeIdPath:'999:888'};return Response.json(result);}
    if(mode==='detail'){const result=overviewDetails();result.entry.report.reportHash='f'.repeat(64);return Response.json(result);}
    return Response.json({study:{id:overviewStudyId,scope:{...overviewScope,nodeIdPath:'999:888'},createdAt:'2026-09-12T00:00:00.000Z'}});
  };
  try{await assert.rejects(readOverviewRun('../other'));assert.equal(calls,0);await assert.rejects(readOverviewRun(overviewRunId),/范围不一致/);mode='detail';const entry=overviewEntry();await assert.rejects(readOverviewDetails(overviewRunId,entry.attemptId,entry.report.reportHash),/版本不一致/);
    mode='study';await assert.rejects(createOverviewStudy({marketplace:'US',currency:'USD',nodeIdPath:'123:456',fromMonth:'2026-07',toMonth:'2026-08'},overviewStudyId),/范围不一致/);
  }finally{globalThis.fetch=saved;}
});
