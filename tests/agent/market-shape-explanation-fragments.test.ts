import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceCatalog } from './helpers/market-shape-explanation-fixture';
import { buildMarketShapeExplanationCatalog } from '../../server/domain/market-research/shape-explanation-catalog';
import { buildMarketShapeExplanationWindows, decodeMarketShapeExplanationWindow } from '../../server/domain/market-research/shape-explanation-wire';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { validateMarketShapeExplanationFragment,collectMarketShapeExplanationFragments } from '../../server/domain/market-research/shape-explanation-fragments';
import type { MarketShapeExplanationCatalog } from '../../shared/market-shape-explanation-contracts';
import type { MarketShapeExplanationWindow } from '../../shared/market-shape-explanation-wire-contracts';
import type { MarketShapeExplanationFragmentOutput } from '../../shared/market-shape-explanation-fragment-contracts';
function output(c:MarketShapeExplanationCatalog,w:MarketShapeExplanationWindow):MarketShapeExplanationFragmentOutput{
 const row=c.rows.find(r=>w.coverage.rowIds.includes(r.id)&&r.cells.some(cell=>cell.value!==null));
 const cell=row?.cells.find(c=>c.value!==null);
 const risk={kind:'risk' as const,parts:[{kind:'text' as const,text:'固定样本和来源边界限制结论。'}],evidenceRowIds:[],limitationCodes:[...new Set(decodeMarketShapeExplanationWindow(c,w).limitations.map(l=>l.code))]};
 const finding=row&&cell?{kind:'observed' as const,parts:[{kind:'text' as const,text:'本窗已保存指标：'},{kind:'cell' as const,rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]}:risk;
 return {version:'market-shape-explanation-fragment/v1',explanationCatalogId:c.explanationCatalogId,revisionId:c.revisionId,windowId:w.windowId,
 section:{dimension:w.dimension,status:row?'explained':'insufficient-evidence',summary:finding,findings:row?[finding]:[],limitations:[risk],verification:[{...risk,kind:'verification',parts:[{kind:'text',text:'核对完整来源后再比较。'}]}]}};
}
async function fixture(){const c=buildMarketShapeExplanationCatalog(await sourceCatalog());const windows=await buildMarketShapeExplanationWindows(c,w=>w.coverage.rowIds.length<=2);return {c,windows};}

test('window results retain exact report binding and completeness only enables synthesis',async()=>{
 const {c,windows}=await fixture();assert.ok(windows.length>6);
 const results=windows.map(w=>({status:'succeeded' as const,windowId:w.windowId,output:output(c,w)}));
 const done=collectMarketShapeExplanationFragments(c,windows,results.reverse());
 assert.equal(done.status,'ready-for-synthesis');assert.equal(done.synthesisStatus,'not-started');assert.equal(done.successful.length,windows.length);
 assert.deepEqual(done.successful.map(o=>o.windowId),windows.map(w=>w.windowId));
 assert.throws(()=>done.successful.pop());
});

test('metadata coverage is required even when every numeric row is present',async()=>{
 const {c,windows}=await fixture();
 const altered=windows.map(w=>{if(!w.limitations.length)return w;const {windowId,...body}=w;const updated={...body,limitations:[]};return {...updated,windowId:'market-shape-explanation-window:'+digest(updated)};});
 assert.ok(windows.some(w=>w.limitations.length));
 assert.throws(()=>collectMarketShapeExplanationFragments(c,altered,[]),/limitation fragment/);
});

test('local output cannot cite source detail that was only sent to another window',async()=>{
 const {c,windows}=await fixture(),w=windows.find(w=>w.dimension==='brand')!,o=output(c,w);
 const visible=new Set(decodeMarketShapeExplanationWindow(c,w).limitations.map(l=>l.code));
 const outside=c.limitations.find(l=>!visible.has(l.code));assert.ok(outside);
 o.section.limitations[0].limitationCodes.push(outside.code);
 assert.throws(()=>validateMarketShapeExplanationFragment(c,w,o),/limitation.*outside/);
});

test('same-dimension rows from another window cannot support a local finding',async()=>{
 const {c,windows}=await fixture();const w=windows.find(w=>w.dimension==='brand')!,o=output(c,w);
 const foreign=c.rows.find(r=>r.dimension==='brand'&&!w.coverage.rowIds.includes(r.id))!;
 o.section.summary={kind:'inferred',parts:[{kind:'text',text:'超出本窗的结论。'}],evidenceRowIds:[foreign.id],limitationCodes:[]};
 assert.throws(()=>validateMarketShapeExplanationFragment(c,w,o),/outside.*window/);
 const wrong=output(c,w);wrong.windowId=windows.find(x=>x.windowId!==w.windowId)!.windowId;
 assert.throws(()=>validateMarketShapeExplanationFragment(c,w,wrong),/identity/);
});

test('failed and pending fragments preserve successful work, and only failed result replacement restores readiness',async()=>{
 const {c,windows}=await fixture();const success=windows.slice(1).map(w=>({status:'succeeded' as const,windowId:w.windowId,output:output(c,w)}));
 const pending=collectMarketShapeExplanationFragments(c,windows,success);assert.equal(pending.status,'pending');assert.deepEqual(pending.pending,[windows[0].windowId]);
 const partial=collectMarketShapeExplanationFragments(c,windows,[...success,{status:'failed',windowId:windows[0].windowId,errorCode:'timeout'}]);
 assert.equal(partial.status,'partial');assert.equal(partial.successful.length,success.length);assert.equal(partial.synthesisStatus,'not-started');
 const restored=collectMarketShapeExplanationFragments(c,windows,[...success,{status:'succeeded',windowId:windows[0].windowId,output:output(c,windows[0])}]);
 assert.equal(restored.status,'ready-for-synthesis');assert.deepEqual(partial.failed,[{windowId:windows[0].windowId,errorCode:'timeout'}]);
});

test('an incomplete manifest, duplicate success, foreign result or omitted limitation is rejected',async()=>{
 const {c,windows}=await fixture();const w=windows[0],o=output(c,w),result={status:'succeeded',windowId:w.windowId,output:o};
 assert.throws(()=>collectMarketShapeExplanationFragments(c,windows.slice(1),[]),/manifest/);
 assert.throws(()=>collectMarketShapeExplanationFragments(c,[...windows,w],[]),/Duplicate/);
 assert.throws(()=>collectMarketShapeExplanationFragments(c,windows,[result,result]),/Duplicate/);
 assert.throws(()=>collectMarketShapeExplanationFragments(c,windows,[{status:'failed',windowId:'foreign',errorCode:'timeout'}]),/unknown/);
 o.section.limitations[0].limitationCodes=[];o.section.limitations[0].evidenceRowIds=[w.coverage.rowIds[0]];
 assert.throws(()=>validateMarketShapeExplanationFragment(c,w,o),/omitted/);
});
