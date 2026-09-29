import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asinsNeedingPrimaryCatalogSync as asinsNeedingCatalogSync, appendCatalogEntry } from '../../scripts/lib/catalog-sync.mjs';
import { readCachedArrayExport } from '../../scripts/lib/sync-cache.mjs';
import { asinsNeedingCatalogSync as planCatalog } from '../../scripts/lib/asin-data-status.mjs';

test('runner separates available fallback from primary retry eligibility', () => {
  const asin = 'B0FGJNBNYD';
  const sources = { catalogAsins: [asin], catalogProducts: [{asin,catalogSource:'sorftime-fallback'}] };
  assert.deepEqual(planCatalog([asin], {sources}), []);
  assert.deepEqual(planCatalog([asin], {sources,retryFallback:true}), [asin]);
});

test('SellerSprite retries a fallback and upgrades only that catalog entry', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'catalog.ts');
  const fallback = { asin: 'B0FGJNBNYD', catalogSource: 'sorftime-fallback', synced: false, title: 'existing title' };
  const sibling = { asin: 'B0DQDD5SY5', catalogSource: 'sellerSprite', synced: true, price: 25 };
  fs.writeFileSync(file, `// retained header\nexport const refreshedCatalog = ${JSON.stringify([fallback, sibling])};\n`);
  assert.deepEqual(asinsNeedingCatalogSync([fallback.asin, sibling.asin], file), [fallback.asin]);
  const replacement = { ...fallback, catalogSource: 'sellerSprite', synced: true, price: 32 };
  assert.equal(appendCatalogEntry(replacement, file), true);
  assert.deepEqual(readCachedArrayExport(file, 'refreshedCatalog'), [replacement, sibling]);
  assert.deepEqual(asinsNeedingCatalogSync([fallback.asin, sibling.asin], file), []);
  assert.equal(appendCatalogEntry({ ...sibling, price: 999 }, file), false);
  assert.match(fs.readFileSync(file, 'utf8'), /^\/\/ retained header/);
});
