import assert from 'node:assert/strict';
import test from 'node:test';
import {requestSorftimeMcp} from '../../scripts/lib/sorftime-mcp-client.mjs';
test('current trend metrics have distinct governed request identities and repeated metrics remain stable', async () => {
  const attempts=[];
  for (const type of ['SalesVolume','SalesAmount','Price','Rank','Price']) {
    await requestSorftimeMcp('fixture','tools/call',{name:'product_trend',arguments:{asin:'B0BWCQHCWX',amz_site:'US',type}}, {
      env:{NODE_ENV:'test',AGENT_SYNC_STAGE_ID:'sales_trend',SORFTIME_MCP_ENDPOINT:'http://127.0.0.1:1/mcp'},
      organizationId:'fixture-org', jobId:'fixture-job',
      resourceGovernor:{async run(input){attempts.push(input.logicalOperationKey);return input.operation();}},
      fetchImpl:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[]}})),
    });
  }
  assert.equal(new Set(attempts.slice(0,4)).size,4);
  assert.equal(attempts[2],attempts[4]);
});
