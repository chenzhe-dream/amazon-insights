import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMarketShapeExplanationCatalog } from '../../server/domain/market-research/shape-explanation-catalog';
import { buildMarketShapeExplanationWindows, decodeMarketShapeExplanationWindow, decodeMarketShapeExplanationWindows, validateMarketShapeExplanationWindow } from '../../server/domain/market-research/shape-explanation-wire';
import { sourceCatalog } from './helpers/market-shape-explanation-fixture';

test('compact dimension windows round trip every row, cell, zero, null, context and limitation', async () => {
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog());
  const windows=await buildMarketShapeExplanationWindows(catalog, value=>JSON.stringify(value).length<=2500);
  assert.ok(windows.length>6);
  assert.deepEqual(decodeMarketShapeExplanationWindows(catalog,windows),{rows:catalog.rows,limitations:catalog.limitations});
  const seen=windows.flatMap(w=>w.coverage.rowIds);
  assert.equal(seen.length,new Set(seen).size);
  assert.deepEqual(new Set(seen),new Set(catalog.rows.map(r=>r.id)));
  for(const window of windows){
    assert.ok(window.rows.length || window.limitations.length);
    assert.ok(window.rows.every(r=>catalog.rows.find(x=>x.id===window.dictionary.strings[r[0]])?.dimension===window.dimension));
    assert.deepEqual(validateMarketShapeExplanationWindow(catalog,window),window);
    const decoded=decodeMarketShapeExplanationWindow(catalog,window);
    assert.deepEqual(decoded.rows.map(row=>row.id),window.coverage.rowIds);
    assert.deepEqual(new Set(decoded.limitations.map(item=>item.code)),new Set([...window.rules.limitations.map(item=>item.code),...window.limitations.map(item=>window.dictionary.strings[item[0]]!)]));
  }
});

test('each window carries the catalog source policy once through rules',async()=>{
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog('market-shape-price-catalog/v3',true));
  const windows=await buildMarketShapeExplanationWindows(catalog,()=>true);
  assert.ok(catalog.source.sourcePolicy);
  for(const window of windows){
    const policies=window.rules.limitations.filter(item=>item.code==='source-policy-boundaries');
    assert.equal(policies.length,1);
    assert.equal(policies[0]!.detail,catalog.source.sourcePolicy);
    assert.equal('sourcePolicy' in window.source,false);
  }
});

test('identity binds compact references to one catalog revision and rejects unknown references', async()=>{
  const a=buildMarketShapeExplanationCatalog(await sourceCatalog());
  const b=buildMarketShapeExplanationCatalog(await sourceCatalog('market-shape-price-catalog/v1'));
  const [window]=await buildMarketShapeExplanationWindows(a,()=>true);
  assert.throws(()=>validateMarketShapeExplanationWindow(b,window));
  const bad=structuredClone(window) as any; bad.rows[0][0]=999999;
  assert.throws(()=>validateMarketShapeExplanationWindow(a,bad));
});

test('uses the async request-budget callback, never emits an oversized window, and fails an impossible atomic row',async()=>{
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog());
  let calls=0; const fits=async(value:unknown)=>{calls++; return JSON.stringify(value).length<=7000};
  const windows=await buildMarketShapeExplanationWindows(catalog,fits);
  assert.ok(calls>windows.length);
  for(const window of windows) assert.equal(await fits(window),true);
  await assert.rejects(buildMarketShapeExplanationWindows(catalog,async()=>false),/cannot fit|budget/i);
});

test('abort stops budget probing and stable content gives stable identities',async()=>{
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog());
  const first=await buildMarketShapeExplanationWindows(catalog,v=>JSON.stringify(v).length<=6000);
  const second=await buildMarketShapeExplanationWindows(catalog,v=>JSON.stringify(v).length<=6000);
  assert.deepEqual(first.map(x=>x.windowId),second.map(x=>x.windowId));
  const controller=new AbortController(); controller.abort();
  await assert.rejects(buildMarketShapeExplanationWindows(catalog,()=>true,controller.signal),e=>(e as Error).name==='AbortError');
});

test('empty JSON-array limitations survive as one reversible semantic fragment',async()=>{
  const catalog=structuredClone(buildMarketShapeExplanationCatalog(await sourceCatalog())) as any;
  catalog.limitations.push({code:'empty-list',detail:'[]'});
  const {explanationCatalogId,...body}=catalog;
  const {canonicalJsonSha256}=await import('../../server/runtime/model-request-accounting');
  catalog.explanationCatalogId='market-shape-explanation:'+canonicalJsonSha256(body);
  const windows=await buildMarketShapeExplanationWindows(catalog,()=>true);
  assert.deepEqual(decodeMarketShapeExplanationWindows(catalog,windows).limitations.at(-1),{code:'empty-list',detail:'[]'});
});

test('non-canonical JSON limitation arrays fail explicitly instead of silently changing bytes',async()=>{
  const catalog=structuredClone(buildMarketShapeExplanationCatalog(await sourceCatalog())) as any;
  catalog.limitations.push({code:'spaced-list',detail:'[ 1 ]'});
  const {explanationCatalogId,...body}=catalog;
  const {canonicalJsonSha256}=await import('../../server/runtime/model-request-accounting');
  catalog.explanationCatalogId='market-shape-explanation:'+canonicalJsonSha256(body);
  await assert.rejects(buildMarketShapeExplanationWindows(catalog,()=>true),/canonical JSON/i);
});

test('complete decode rejects empty, missing, duplicate and inconsistent fragment manifests',async()=>{
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog());
  const windows=await buildMarketShapeExplanationWindows(catalog,v=>JSON.stringify(v).length<=3000);
  assert.throws(()=>decodeMarketShapeExplanationWindows(catalog,[]),/complete|window|manifest/i);
  assert.throws(()=>decodeMarketShapeExplanationWindows(catalog,windows.slice(1)),/complete|missing|manifest/i);
  assert.throws(()=>decodeMarketShapeExplanationWindows(catalog,[...windows,windows[0]]),/duplicate|manifest/i);
  const altered=structuredClone(windows) as any[];
  altered[0].fragment.count++;
  const {windowId,...body}=altered[0];
  const {canonicalJsonSha256}=await import('../../server/runtime/model-request-accounting');
  altered[0].windowId='market-shape-explanation-window:'+canonicalJsonSha256(body);
  assert.throws(()=>decodeMarketShapeExplanationWindows(catalog,altered),/fragment|manifest/i);
});

test('validation rejects non-canonical dictionary and duplicate context encodings even after rehash',async()=>{
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog());
  const windows=await buildMarketShapeExplanationWindows(catalog,()=>true);
  const source=windows.find(window=>window.rows.some(row=>row[1].length))!;
  const {canonicalJsonSha256}=await import('../../server/runtime/model-request-accounting');
  const rehash=(input:any)=>{const {windowId,...body}=input;input.windowId='market-shape-explanation-window:'+canonicalJsonSha256(body);return input};
  const unused=structuredClone(source) as any;unused.dictionary.strings.push('unbound model text');rehash(unused);
  assert.throws(()=>validateMarketShapeExplanationWindow(catalog,unused),/canonical|encoding/i);
  const repeated=structuredClone(source) as any;repeated.rows.find((row:any)=>row[1].length)[1].push([...repeated.rows.find((row:any)=>row[1].length)[1][0]]);rehash(repeated);
  assert.throws(()=>validateMarketShapeExplanationWindow(catalog,repeated),/canonical|encoding/i);
});


test('non-array rules cannot be duplicated as window evidence even with a canonical dictionary',async()=>{
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog());
  const [window]=await buildMarketShapeExplanationWindows(catalog,()=>true);
  const rule=window.rules.limitations[0],copy=structuredClone(window);
  let index=copy.dictionary.strings.indexOf(rule.code);
  if(index<0){index=copy.dictionary.strings.length;copy.dictionary.strings.push(rule.code);}
  copy.limitations.push([index,1,1,'text',rule.detail]);
  const {canonicalJsonSha256}=await import('../../server/runtime/model-request-accounting');
  const {windowId,...body}=copy;copy.windowId='market-shape-explanation-window:'+canonicalJsonSha256(body);
  assert.throws(()=>validateMarketShapeExplanationWindow(catalog,copy),/text.*limitation|canonical|encoding/i);
});
