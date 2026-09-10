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
  for(const detail of [{}, {data:[]}, {data:{asin}}, {data:{asin:'B000000000',node_id:''}}]) {
    const result=await collect(detail);
    assert.equal(result.diagnostics[0].causeCode,'MCP_SCHEMA');
  }
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
