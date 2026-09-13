import assert from 'node:assert/strict';
import test from 'node:test';
import { readThemeRun, readThemeDetails, createThemeStudy, readThemeEvidence } from '../../app/lib/market-theme-browser';
import { themeDetails, themeEntry, themeRunId, themeEvidence } from './helpers/market-theme-page-fixture';

const id='10000000-0000-4000-8000-000000000001';
test('theme browser validates before fetch, uses same origin and rejects malformed results', async () => {
  const before=globalThis.fetch; let calls=0;
  globalThis.fetch=async (path,init)=>{calls++;assert.match(String(path),/^\/api\/agent\/v1\/market-analysis\//);assert.equal(init?.credentials,'same-origin');return Response.json({run:{}});};
  try {
    await assert.rejects(readThemeRun('../outside'));assert.equal(calls,0);
    await assert.rejects(readThemeDetails(id,id,'0'.repeat(64),{section:'members',limit:51}));assert.equal(calls,0);
    await assert.rejects(readThemeRun(id),/格式/);assert.equal(calls,1);
    await assert.rejects(createThemeStudy({marketplace:'US',nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-07',currency:'USD'},id));assert.equal(calls,1);
  } finally {globalThis.fetch=before;}
});
test('optional group filter is omitted, and report identity is checked after response',async()=>{
  const before=globalThis.fetch;let mismatch=false;
  globalThis.fetch=async path=>{const url=new URL(String(path),'http://localhost');assert.equal(url.searchParams.has('groupIndex'),false);const response=themeDetails(url);if(mismatch)response.report.report.reportHash='f'.repeat(64);return Response.json(response);};
  try{const entry=themeEntry();await readThemeDetails(themeRunId,entry.attemptId,entry.report.reportHash,{section:'groups',groupIndex:undefined});mismatch=true;await assert.rejects(readThemeDetails(themeRunId,entry.attemptId,entry.report.reportHash,{}),/身份不一致/);}finally{globalThis.fetch=before;}
});
test('full evidence must belong to the selected report and original theme',async()=>{
  const before=globalThis.fetch;let tamper=false;
  globalThis.fetch=async path=>{const result=themeEvidence(new URL(String(path),'http://localhost'));if(tamper)result.evidence.sourceThemeId='outsider';return Response.json(result);};
  try{const entry=themeEntry();const full=await readThemeEvidence(themeRunId,entry.attemptId,entry.report.reportHash,'synthetic-theme-1');assert.equal(full.content.length,12000);tamper=true;await assert.rejects(readThemeEvidence(themeRunId,entry.attemptId,entry.report.reportHash,'synthetic-theme-1'),/身份不一致/);}finally{globalThis.fetch=before;}
});
