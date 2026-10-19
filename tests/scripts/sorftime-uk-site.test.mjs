import assert from "node:assert/strict";
import test from "node:test";
import { callSorftimeTool } from "../../scripts/lib/sorftime-mcp-client.mjs";

test("UK project uses GB in both the Sorftime request and source-cache identity", async () => {
  let sent;
  let cached;
  await callSorftimeTool("test-key", "product_detail", { asin: "B0FJ4T6V2C", amz_site: "UK" }, {
    env: {}, requireResourceGovernor: false, emitDiagnostics: false,
    sourceCache: { run: async (input, execute) => { cached = input.args; return execute(); } },
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body).params.arguments;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"data":{"asin":"B0FJ4T6V2C"}}' }] } }), { status: 200 });
    },
  });
  assert.equal(sent.amz_site, "GB");
  assert.equal(cached.amz_site, "GB");
});

test("Customers Say maps its site argument to GB before dispatch and caching", async () => {
 let sent, cached;
 await callSorftimeTool('test-key','product_customers_say',{asin:'B0C6FP6LMY',site:'UK'},{env:{},requireResourceGovernor:false,emitDiagnostics:false,
 sourceCache:{run:async(input,execute)=>{cached=input.args;return execute();}},
 fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body).params.arguments;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'No relevant data.'}]}}),{status:200});}});
 assert.equal(sent.site,'GB');assert.equal(cached.site,'GB');
});
