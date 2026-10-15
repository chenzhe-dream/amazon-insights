import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPreviousMarketResult, needsPreviousMarketResult, sameRetainedConditions, type RetainableMarketRun} from '../../app/lib/market-retained-result';
const run = (id: string, hasData = false): RetainableMarketRun & {hasData: boolean} => ({id, hasData, scope: {organizationId:'org-a',researchId:id,marketplace:'US',nodeIdPath:'12:34',fromMonth:'2026-09',toMonth:'2026-09',currency:'USD'},params:{poolSize:100,memberCount:20},steps:[]});
test('historical fallback checks business conditions, ignores study IDs and object key ordering', () => {
  const a=run('new'),b=run('old',true); b.scope.nodeIdPath='34';b.params={memberCount:20,poolSize:100};
  assert.equal(sameRetainedConditions(a,b),true);
  for(const [key,value] of Object.entries({organizationId:'other',marketplace:'DE',nodeIdPath:'99',fromMonth:'2026-08',toMonth:'2026-08',currency:'EUR',overviewPeriod:'last30'})) {
    assert.equal(sameRetainedConditions(a,{...b,scope:{...b.scope,[key]:value}}),false,key);
  }
  assert.equal(sameRetainedConditions(a,{...b,params:{memberCount:10,poolSize:100}}),false);
  assert.equal(sameRetainedConditions(a,{...b,scope:{...b.scope,nodeIdPath:'99:34'}}),false);
});
test('failed refresh chain restores original usable result without creating any work',async()=>{
  const rows=[run('new'),run('failed'),run('saved',true)];const reads:string[]=[];
  const result=await loadPreviousMarketResult(rows[0],async id=>{reads.push(id);return rows.find(row=>row.id===id)!;},id=>({new:'failed',failed:'saved'})[id as 'new'|'failed']??null,row=>row.hasData,new AbortController().signal);
  assert.equal(result?.id,'saved');assert.deepEqual(reads,['failed','saved']);
});
test('authorization/read errors propagate; mismatched identity, scope, cycles and abort fail closed',async()=>{
  const current=run('new'),old=run('old',true),signal=new AbortController().signal;
  await assert.rejects(loadPreviousMarketResult(current,async()=>{throw Object.assign(new Error('forbidden'),{status:403});},()=>old.id,row=>row.hasData,signal),/forbidden/);
  assert.equal(await loadPreviousMarketResult(current,async()=>({...old,id:'wrong'}),()=>old.id,row=>row.hasData,signal),null);
  assert.equal(await loadPreviousMarketResult(current,async()=>({...old,scope:{...old.scope,marketplace:'DE'}}),()=>old.id,row=>row.hasData,signal),null);
  let reads=0;assert.equal(await loadPreviousMarketResult(current,async()=>{reads++;return run('old');},id=>id==='new'?'old':'new',row=>row.hasData,signal),null);assert.equal(reads,1);
  const abort=new AbortController();abort.abort();await assert.rejects(loadPreviousMarketResult(current,async()=>old,()=>old.id,row=>row.hasData,abort.signal));
});

test('a partial new report cannot hide previous results while current source steps failed',()=>{
  const partial={...run('partial',true),status:'partial',steps:[{current:true,status:'failed',errorCode:'quota-exhausted'}]};
  assert.equal(needsPreviousMarketResult(partial,row=>row.hasData),true);
  assert.equal(needsPreviousMarketResult({...partial,status:'succeeded',steps:[]},row=>row.hasData),false);
  assert.equal(needsPreviousMarketResult({...partial,status:'succeeded',steps:[{current:false,status:'failed'}]},row=>row.hasData),false);
  assert.equal(needsPreviousMarketResult(run('empty'),row=>row.hasData),true);
});
