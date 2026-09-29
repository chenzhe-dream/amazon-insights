import assert from 'node:assert/strict';
import test from 'node:test';
import {collectSorftimeCategoryRecords} from '../../scripts/build-sorftime-category-trend.mjs';
const asin='B0CZRBL776';
async function collect(detail) {
  return collectSorftimeCategoryRecords({key:'fixture',marketplace:'US',catalog:[{asin}],existing:{},fetchedAt:'2026-09-10',wait:async()=>{},callTool:async(_key,operation)=>{
    assert.equal(operation,'product_detail'); return detail;
  }});
}
test('an identified product with an explicitly empty category node stays upstream empty',async()=>{
  const result=await collect({data:{asin,node_id:''}});
  assert.deepEqual(result.diagnostics,[]);
  assert.equal(result.records[`asin-error:${asin}`].status,'empty');
  assert.equal(result.records[`asin-error:${asin}`].statusMessage,'UPSTREAM_EMPTY');
  assert.equal(result.nodePlan.size,0);
});
test('missing or invalid category identity and node remain schema failures',async()=>{
  for(const detail of [{}, {data:[]}, {data:{asin}}, {data:{asin:'B000000000',node_id:''}}, {data:{asin:'B000000000',node_id:'12345'}}]) {
    const result=await collect(detail);
    assert.equal(result.diagnostics[0].causeCode,'MCP_SCHEMA');
  }
});

test('a scoped category refresh preserves untargeted ASIN associations and their original date', async () => {
  const sibling = 'B0BHHP21DP';
  const existing = { '12345': { nodeId: '12345', marketplace: 'US', status: 'ready', fetchedAt: '2026-09-01', asins: [asin, sibling], volume: [{ month: '2026-08', value: 10 }] } };
  const result = await collectSorftimeCategoryRecords({
    key: 'fixture', marketplace: 'US', catalog: [{ asin }], existing,
    fetchedAt: '2026-09-29', jobId: 'new-job', wait: async () => {},
    callTool: async (_key, operation) => operation === 'product_detail'
      ? { data: { asin, node_id: '12345' } } : { data: ['2026-09=20'] },
  });
  assert.deepEqual(result.records['12345'].asins, [sibling, asin]);
  assert.equal(result.records['12345'].associationFetchedAtByAsin[sibling], '2026-09-01');
  assert.equal(result.records['12345'].associationFetchedAtByAsin[asin], '2026-09-29');
});

test('a scoped refresh never preserves a mapping from another marketplace or the previous node of a targeted ASIN', async () => {
  const existing = { old: { nodeId: 'old', marketplace: 'US', status: 'ready', asins: [asin], volume: [{month:'2026-08',value:10}] }, '12345': { nodeId:'12345', marketplace:'UK',status:'ready',asins:['B0BHHP21DP'],volume:[{month:'2026-08',value:10}] } };
  const result = await collectSorftimeCategoryRecords({key:'fixture',marketplace:'US',catalog:[{asin}],existing,fetchedAt:'2026-09-29',jobId:'new-job',wait:async()=>{},callTool:async(_key,operation)=>operation==='product_detail'?{data:{asin,node_id:'12345'}}:{data:['2026-09=20']}});
  assert.deepEqual(result.records['12345'].asins,[asin]);
  assert.ok(!result.records.old?.asins.includes(asin));
});

test('an empty category does not discard a successful sibling trend', async () => {
  const sibling = 'B0BHHP21DP';
  const result = await collectSorftimeCategoryRecords({
    key: 'fixture', marketplace: 'US', catalog: [{ asin }, { asin: sibling }],
    existing: {}, fetchedAt: '2026-09-10', wait: async () => {},
    callTool: async (_key, operation, args) => operation === 'product_detail'
      ? { data: { asin: args.asin, node_id: args.asin === asin ? '' : '12345' } }
      : { data: ['2026-08=10'] },
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.records['12345'].status, 'ready');
  assert.deepEqual(result.records['12345'].asins, [sibling]);
  assert.equal(result.records[`asin-error:${asin}`].status, 'empty');
});
