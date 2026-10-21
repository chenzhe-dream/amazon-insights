import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatedAppDataPath } from '../../scripts/lib/generated-app-data-path.mjs';
import { asinsNeedingSorftimeCatalogSync, buildCatalogEntryFromSorftime } from '../../scripts/lib/sorftime-catalog-fallback.mjs';
import { buildCatalogEntryFromSellerSprite, appendCatalogEntry } from '../../scripts/lib/catalog-sync.mjs';
import { readCachedArrayExport } from '../../scripts/lib/sync-cache.mjs';
import { callSorftimeTool } from '../../scripts/lib/sorftime-mcp-client.mjs';
import { callSifTool } from '../../scripts/lib/sif-mcp-client.mjs';
import { callSellerSpriteMcpTool } from '../../scripts/lib/sellersprite-mcp-client.mjs';

const asin = 'B0TEST0001';
const currencies = { US: 'USD', UK: 'GBP', DE: 'EUR', CA: 'CAD' };
for (const marketplace of ['UK', 'DE', 'CA']) {
  test(`${marketplace} catalog cannot reuse the same ASIN from a foreign marketplace`, () => {
    const catalogProducts = [{ asin, marketplace: 'US', catalogSource: 'sorftime-fallback', catalogProfileVersion: 1 }];
    assert.deepEqual(asinsNeedingSorftimeCatalogSync([asin], { marketplace, catalogProducts }), [asin]);
    catalogProducts.push({ ...catalogProducts[0], marketplace });
    assert.deepEqual(asinsNeedingSorftimeCatalogSync([asin], { marketplace, catalogProducts }), []);
  });
  test(`${marketplace} catalog persists marketplace and correct fee currency`, () => {
    const currency = currencies[marketplace];
    const entry = buildCatalogEntryFromSorftime({ asin, marketplace, detail: { asin, fba_fee: 4.2 } });
    assert.equal(entry.currency, currency);
    assert.match(entry.specifications.join(' '), new RegExp(`${currency} 4\\.20`));
    const primary = buildCatalogEntryFromSellerSprite({ asin, price: 20 }, [], marketplace);
    assert.equal(primary.marketplace, marketplace);
    assert.equal(primary.currency, currency);
  });
  test(`${marketplace} fallback profile upgrades keep site currency metadata`, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'de-ca-upgrade-'));
    try {
      const file = path.join(fixture, 'catalog.ts');
      fs.writeFileSync(file, `export const refreshedCatalog = ${JSON.stringify([{ asin, marketplace, catalogSource: 'sorftime-fallback', title: 'preserved' }])};\n`);
      appendCatalogEntry(buildCatalogEntryFromSorftime({ asin, marketplace, detail: { asin, brand: 'verified' } }), file);
      const [upgraded] = readCachedArrayExport(file, 'refreshedCatalog');
      assert.equal(upgraded.currency, currencies[marketplace]);
      assert.equal(upgraded.title, 'preserved');
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });
  test(`${marketplace} never reads US generated files even outside formal launcher`, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'de-ca-collection-'));
    try {
      fs.mkdirSync(path.join(fixture, 'app'));
      fs.writeFileSync(path.join(fixture, 'app', 'competitor-data.ts'), 'US cache');
      const env = { AGENT_SYNC_MARKETPLACE: marketplace, AGENT_EXECUTION_ORGANIZATION_ID: 'org', AGENT_SYNC_PROJECT_ID: 'project' };
      const target = generatedAppDataPath(fixture, 'competitor-data.ts', env);
      assert.notEqual(target, path.join(fixture, 'app', 'competitor-data.ts'));
      assert.equal(fs.readFileSync(target, 'utf8'), 'export const refreshedCatalog = [];\n');
      assert.notEqual(target, generatedAppDataPath(fixture, 'competitor-data.ts', { ...env, AGENT_SYNC_MARKETPLACE: marketplace === 'DE' ? 'CA' : 'DE' }));
      assert.throws(() => generatedAppDataPath(fixture, 'competitor-data.ts', { AGENT_SYNC_MARKETPLACE: marketplace }), /exact project scope/);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });
  test(`${marketplace} provider requests and shared cache identities retain exact site`, async () => {
    for (const provider of ['sorftime', 'sif', 'sellerSprite']) {
      let cached, sent;
      const args = provider === 'sorftime' ? { asin, amz_site: marketplace } : provider === 'sif' ? { asin, country: marketplace } : { asin, marketplace };
      const options = { env: { SIF_MCP_SECRET: 'test-key' }, requireResourceGovernor: false, emitDiagnostics: false,
        sourceCache: { run: async (input, execute) => { cached = input.args; return execute({ recordAttempt: async () => {} }); } },
        fetchImpl: async (_url, options) => { sent = JSON.parse(options.body).params.arguments; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"data":[]}' }] } }), { status: 200 }); },
        organizationId: 'org', jobId: 'job', sessionScope: 'market',
        sessionPool: { request: async (_key, _endpoint, _method, params) => { sent = params.arguments; return { content: [{ type: 'text', text: '{"data":[]}' }] }; } },
      };
      if (provider === 'sorftime') await callSorftimeTool('test-key', 'product_detail', args, options);
      else if (provider === 'sif') await callSifTool('market_get_asin_keyword_signals', args, options);
      else await callSellerSpriteMcpTool('test-key', 'asin_detail', args, options);
      const expected = provider === 'sorftime' && marketplace === 'UK' ? { ...args, amz_site: 'GB' } : args;
      assert.deepEqual(sent, expected);
      assert.deepEqual(cached, expected);
    }
  });
  test(`${marketplace} every collection stage uses an isolated cache with no US seed`, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'de-ca-stages-'));
    const codeRoot = path.join(fixture, 'code');
    const env = { AGENT_FORMAL_WORKTREE_ROOT: codeRoot, AGENT_DATA_ROOT: path.join(fixture, 'data'), AGENT_RUNTIME_ROOT: path.join(fixture, 'runtime'),
      AGENT_SYNC_MARKETPLACE: marketplace, AGENT_EXECUTION_ORGANIZATION_ID: 'org', AGENT_SYNC_PROJECT_ID: 'project' };
    try {
      fs.mkdirSync(path.join(codeRoot, 'app'), { recursive: true });
      for (const fileName of ['competitor-data.ts', 'sif-keyword-analysis-data.ts', 'sif-keyword-enrichment-data.ts', 'sorftime-review-analysis-data.ts', 'sorftime-rating-data.ts', 'sorftime-sales-trend-data.ts', 'sorftime-child-sales-data.ts', 'sorftime-price-strategy-data.ts', 'sorftime-fba-fee-data.ts', 'sorftime-listing-content-data.ts', 'sorftime-category-trend-data.ts', 'sif-listing-traffic-raw-data.ts', 'sif-monthly-traffic-trend-raw-data.ts', 'listing-image-remarks.ts']) {
        fs.writeFileSync(path.join(codeRoot, 'app', fileName), 'US seed');
        const target = generatedAppDataPath(codeRoot, fileName, env);
        assert.equal(fs.existsSync(target), fileName === 'competitor-data.ts', fileName);
        fs.writeFileSync(target, `${marketplace} actual evidence`);
        for (const owner of [{ AGENT_SYNC_MARKETPLACE: marketplace === 'DE' ? 'CA' : 'DE' }, { AGENT_EXECUTION_ORGANIZATION_ID: 'other' }, { AGENT_SYNC_PROJECT_ID: 'other' }]) {
          assert.notEqual(generatedAppDataPath(codeRoot, fileName, { ...env, ...owner }), target, fileName);
        }
        assert.equal(fs.readFileSync(target, 'utf8'), `${marketplace} actual evidence`);
      }
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });
}

test('US catalog keeps USD while the other three marketplace currencies stay distinct', () => {
  for (const [marketplace, currency] of Object.entries(currencies)) {
    const fallback = buildCatalogEntryFromSorftime({ asin, marketplace, detail: { asin, fba_fee: 4.2 } });
    const primary = buildCatalogEntryFromSellerSprite({ asin, price: 20 }, [], marketplace);
    assert.equal(fallback.marketplace, marketplace);
    assert.equal(fallback.currency, currency);
    assert.equal(primary.marketplace, marketplace);
    assert.equal(primary.currency, currency);
  }
});
