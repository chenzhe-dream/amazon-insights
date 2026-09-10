import assert from 'node:assert/strict';
import test from 'node:test';
import * as cache from '../../scripts/lib/sync-cache.mjs';

test('repair refuses ready keyword shells and review blocks without rows', () => {
  assert.equal(cache.hasCompleteKeywordRecord?.({status:'ready', keywords:[]}), false);
  assert.equal(cache.hasCompleteReviewRecord?.({status:'ready', sampledReviews:10, blocks:[{rows:[]}]}), false);
  assert.equal(cache.hasCompleteKeywordRecord?.({status:'empty', terminalReason:'valid-empty', keywords:[]}), false);
  assert.equal(cache.hasCompleteReviewRecord?.({status:'ready', blocks:[{rows:[{label:'quality'}]}]}), true);
});

test('repair preserves old portions on empty replacement and deletion with a failure diagnostic', () => {
  const old = {status:'pending', volume:[{month:'2026-01',value:4}], amount:[]};
  const events=[];
  const records=cache.createRepairSafeRecordMap?.({a:old, sibling:{status:'ready',value:5}}, {repair:true, onPreserve: event => events.push(event)});
  assert.ok(records);
  records.a={status:'error',volume:[],amount:[{month:'2026-01',value:8}],statusMessage:'upstream failed'};
  assert.deepEqual(records.a.volume, old.volume);
  assert.deepEqual(records.a, old);
  delete records.a;
  assert.equal(records.a.volume[0].value,4);
  assert.deepEqual(records.sibling,{status:'ready',value:5});
  assert.equal(events.length,2);
});

test('repair mode ignores force and stale age for complete cached records', () => {
  const before=process.env.AGENT_SYNC_REPAIR_INCOMPLETE;
  process.env.AGENT_SYNC_REPAIR_INCOMPLETE='1';
  try { assert.equal(cache.shouldUseCachedRecord({status:'ready',fetchedAt:'2000-01-01'},{forceRefresh:true,maxAgeDays:1}),true); }
  finally { if(before==null) delete process.env.AGENT_SYNC_REPAIR_INCOMPLETE; else process.env.AGENT_SYNC_REPAIR_INCOMPLETE=before; }
});


test('failed repair never assigns fresh timestamps or smaller failed arrays to old evidence', () => {
  const old={status:'pending', fetchedAt:'2026-01-01', provenance:{source:'old'}, keywords:[{keyword:'a'},{keyword:'b'}]};
  const records=cache.createRepairSafeRecordMap({a:old},{repair:true,onPreserve:()=>{}});
  records.a={status:'error', fetchedAt:'2026-09-10',provenance:{source:'new'},keywords:[{keyword:'a'}]};
  assert.deepEqual(records.a,old);
});

test('repair diagnostics identify every targeted ASIN for a shared category node', async () => {
  const {spawnSync}=await import('node:child_process');
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {reportIncompleteRepair} from ${JSON.stringify(new URL('../../scripts/lib/sync-cache.mjs',import.meta.url).href)}; reportIncompleteRepair('12345');`],{encoding:'utf8', env:{...process.env,AGENT_SYNC_STAGE_ID:'category',SORFTIME_ASINS:'B012345678,B087654321'}});
  assert.equal(result.status,1);
  const diagnostics=result.stderr.split('\n').filter(line=>line.startsWith('@@provider-diagnostic@@')).map(line=>JSON.parse(line.slice('@@provider-diagnostic@@'.length)));
  assert.deepEqual(diagnostics.map(item=>item.asin),['B012345678','B087654321']);
  assert.ok(diagnostics.every(item=>item.stage==='category' && item.causeCode==='MCP_SCHEMA'));
});

test('scoped category repair reuses complete siblings without provider dispatch or pruning', async () => {
  const {collectSorftimeCategoryRecords}=await import('../../scripts/build-sorftime-category-trend.mjs');
  const old=process.env.AGENT_SYNC_REPAIR_INCOMPLETE;
  process.env.AGENT_SYNC_REPAIR_INCOMPLETE='1';
  const existing={node:{status:'ready',asins:['B012345678'],volume:[{month:'2026-01',value:4}]},sibling:{status:'ready',asins:['B087654321'],volume:[{month:'2026-01',value:8}]}};
  try {
    const result=await collectSorftimeCategoryRecords({key:'test',marketplace:'US',catalog:[{asin:'B012345678'}],existing,fetchedAt:'2026-09-10',jobId:'test',callTool:async()=>{throw Error('must reuse cache');},wait:async()=>{}});
    assert.deepEqual(result.records,existing);
    assert.deepEqual(result.diagnostics,[]);
  } finally { if(old==null) delete process.env.AGENT_SYNC_REPAIR_INCOMPLETE; else process.env.AGENT_SYNC_REPAIR_INCOMPLETE=old; }
});
