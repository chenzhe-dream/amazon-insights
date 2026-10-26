import assert from 'node:assert/strict';
import test from 'node:test';
import { callSorftimeTool } from '../../scripts/lib/sorftime-mcp-client.mjs';

for (const [marketplace, providerSite] of [['US', 'US'], ['UK', 'GB'], ['DE', 'DE'], ['CA', 'CA']]) {
  for (const [tool, siteField] of [['product_reviews', 'amz_site'], ['product_customers_say', 'site']]) {
    test(`${marketplace} ${tool} uses the same correct site for transport and cache`, async () => {
      const original = { asin: 'B0G7BK6ZF6', [siteField]: marketplace };
      let sent, cached;
      await callSorftimeTool('test-key', tool, original, {
        env: {}, requireResourceGovernor: false, emitDiagnostics: false,
        sourceCache: { run: async (input, execute) => { cached = input.args; return execute(); } },
        fetchImpl: async (_url, options) => {
          sent = JSON.parse(options.body).params.arguments;
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [
            { type: 'text', text: tool === 'product_reviews' ? 'No reviews found.' : 'No relevant data.' },
          ] } }), { status: 200 });
        },
      });
      assert.equal(sent[siteField], providerSite);
      assert.equal(cached[siteField], providerSite);
      assert.equal(sent.asin, original.asin);
      assert.equal(original[siteField], marketplace, 'caller project identity must not be mutated');
    });
  }
}
