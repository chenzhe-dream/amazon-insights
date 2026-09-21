import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureCatalogProductFamilies} from '../../scripts/lib/catalog-sync.mjs';

test('family normalization reads the full entry and never duplicates a late field', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-family-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const target=path.join(dir,'catalog.ts');
  const entry={asin:'B000000001',title:'Table Lamp '+ 'x'.repeat(700),note:'brace } in text',productFamily:'generic',price:12.5};
  fs.writeFileSync(target,'export const refreshedCatalog = '+JSON.stringify([entry],null,2)+';\n');
  const result=ensureCatalogProductFamilies(target);
  const updated=fs.readFileSync(target,'utf8');
  assert.equal(result[0].productFamily,'lighting');
  assert.equal((updated.match(/"productFamily"/g)||[]).length,1);
  assert.equal(JSON.parse(updated.slice(updated.indexOf('['),updated.lastIndexOf(']')+1))[0].price,12.5);
  ensureCatalogProductFamilies(target);assert.equal(fs.readFileSync(target,'utf8'),updated);
});
