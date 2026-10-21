import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asinsNeedingPrimaryCatalogSync as asinsNeedingCatalogSync, asinsNeedingSorftimeCatalogSync as selectFileProfileSync, appendCatalogEntry } from '../../scripts/lib/catalog-sync.mjs';
import * as fallback from '../../scripts/lib/sorftime-catalog-fallback.mjs';
import { readCachedArrayExport } from '../../scripts/lib/sync-cache.mjs';
import { asinsNeedingCatalogSync as planCatalog } from '../../scripts/lib/asin-data-status.mjs';

test('runner separates available fallback from primary retry eligibility', () => {
  const asin = 'B0FGJNBNYD';
  const sources = { catalogAsins: [asin], catalogProducts: [{asin,catalogSource:'sorftime-fallback'}] };
  assert.deepEqual(planCatalog([asin], {sources}), []);
  assert.deepEqual(planCatalog([asin], {sources,retryFallback:true}), [asin]);
});

test('outdated same-market fallback profiles upgrade verified fields without erasing successes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-profile-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'catalog.ts');
  const old = { asin: 'B0H8XB1X9S', marketplace: 'US', catalogSource: 'sorftime-fallback', title: 'old title', packageSize: 'existing package', rating: 4.4, catalogFieldSources: { rating: 'sorftime' }, synced: false };
  const primary = { asin: 'B0TEST0001', catalogSource: 'sellerSprite', title: 'primary title', synced: true };
  const elsewhere = { asin: 'B0TEST0002', marketplace: 'UK', catalogSource: 'sorftime-fallback', synced: false };
  const latest = { asin: 'B0TEST0003', marketplace: 'US', catalogSource: 'sorftime-fallback', catalogProfileVersion: 1, synced: false };
  const unscoped = { asin: 'B0TEST0005', catalogSource: 'sorftime-fallback', synced: false };
  const products = [old, primary, elsewhere, latest, unscoped];
  fs.writeFileSync(file, `export const refreshedCatalog = ${JSON.stringify(products)};\n`);
  assert.equal(typeof fallback.asinsNeedingSorftimeCatalogSync, 'function');
  assert.deepEqual(fallback.asinsNeedingSorftimeCatalogSync([...products.map(item => item.asin), 'B0TEST0004'], { catalogProducts: products, marketplace: 'US' }), [old.asin, elsewhere.asin, 'B0TEST0004']);
  assert.deepEqual(selectFileProfileSync(products.map(item => item.asin), 'US', file), [old.asin, elsewhere.asin]);
  const entry = fallback.buildCatalogEntryFromSorftime({ asin: old.asin, marketplace: 'US', detail: { asin: old.asin, brand: 'Kilindeer', listing_date: '2026-07-13', weight_g: -1 } });
  assert.equal(appendCatalogEntry(entry, file), true);
  const [upgraded] = readCachedArrayExport(file, 'refreshedCatalog');
  assert.equal(upgraded.title, 'old title');
  assert.equal(upgraded.packageSize, 'existing package');
  assert.equal(upgraded.rating, 4.4);
  assert.equal(upgraded.brand, 'Kilindeer');
  assert.equal(upgraded.launch, '2026-07-13');
  assert.equal(upgraded.catalogProfileVersion, 1);
  assert.deepEqual(upgraded.catalogFieldSources, { rating: 'sorftime', brand: 'sorftime', launch: 'sorftime' });
  assert.equal(appendCatalogEntry({ ...entry, asin: primary.asin }, file), false);
  assert.equal(appendCatalogEntry({ ...entry, asin: elsewhere.asin }, file), false);
  assert.equal(appendCatalogEntry({ ...entry, asin: unscoped.asin }, file), false);
  assert.equal(appendCatalogEntry({ ...entry, catalogFieldSources: { brand: 'sorftime', launch: 'sorftime', unknownField: 'sorftime', catalogSource: 'sorftime' }, unknownField: 'must not persist' }, file), true);
  const [safe] = readCachedArrayExport(file, 'refreshedCatalog');
  assert.equal(safe.unknownField, undefined);
  assert.equal(safe.catalogFieldSources.unknownField, undefined);
  assert.equal(safe.catalogFieldSources.catalogSource, undefined);
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
