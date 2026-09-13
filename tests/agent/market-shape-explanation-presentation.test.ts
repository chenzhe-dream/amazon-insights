import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sourceCatalog } from './helpers/market-shape-explanation-fixture';
import { buildMarketShapeExplanationCatalog } from '../../server/domain/market-research/shape-explanation-catalog';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';
import { SHAPE_EXPLANATION_DIMENSIONS, type MarketShapeExplanationOutput, type MarketShapeExplanationStatement } from '../../shared/market-shape-explanation-output-contracts';
import type { MarketShapeExplanationCatalog } from '../../shared/market-shape-explanation-contracts';

async function implementation() {
  const implementationModule = await import('../../server/domain/market-research/shape-explanation-presentation').catch(() => null);
  assert.ok(implementationModule?.presentMarketShapeExplanation, 'fixed-catalog presentation must be implemented');
  return implementationModule.presentMarketShapeExplanation;
}
function output(catalog: MarketShapeExplanationCatalog): MarketShapeExplanationOutput {
  const risk = (): MarketShapeExplanationStatement => ({kind:'risk',parts:[{kind:'text',text:'来源限制须保留，尚不能作成功结论。'}],evidenceRowIds:[],limitationCodes:catalog.limitations.map(l=>l.code)});
  const verification = (): MarketShapeExplanationStatement => ({...risk(),kind:'verification',parts:[{kind:'text',text:'需要核对固定样本。'}]});
  return {version:'market-shape-explanation-output/v1',revisionId:catalog.revisionId,explanationCatalogId:catalog.explanationCatalogId,
    dimensions:SHAPE_EXPLANATION_DIMENSIONS.map(dimension=>({dimension,status:'insufficient-evidence',summary:risk(),findings:[],limitations:[risk()],verification:[verification()]})),
    synthesis:{decision:'insufficient-evidence',summary:risk(),limitations:[risk()],verification:[verification()]}};
}
async function fixture() { const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog()); return {catalog,result:output(catalog)}; }

test('presentation resolves zero, unknown and context from fixed cells, keeping original rows and all limitations', async () => {
  const present=await implementation(), {catalog,result}=await fixture();
  const zeroRow=catalog.rows.find(r=>r.cells.some(c=>c.value===0))!, zero=zeroRow.cells.find(c=>c.value===0)!;
  const unknownRow=catalog.rows.find(r=>r.cells.some(c=>c.value===null))!, unknown=unknownRow.cells.find(c=>c.value===null)!;
  const contextRow=catalog.rows.find(r=>Object.keys(r.context).length>0)!, key=Object.keys(contextRow.context)[0];
  const observed:MarketShapeExplanationStatement={kind:'observed',parts:[{kind:'text',text:'保存值：'},{kind:'cell',rowId:zeroRow.id,cellId:zero.id}],evidenceRowIds:[zeroRow.id],limitationCodes:[]};
  const section=result.dimensions.find(d=>d.dimension===zeroRow.dimension)!;
  section.status='explained'; section.summary=observed; section.findings=[observed,{...observed,kind:'inferred'}];
  result.synthesis.limitations.push({kind:'risk',parts:[{kind:'text',text:'待确认：'},{kind:'cell',rowId:unknownRow.id,cellId:unknown.id},{kind:'context',rowId:contextRow.id,key}],evidenceRowIds:[...new Set([unknownRow.id,contextRow.id])],limitationCodes:[]});
  const before=JSON.stringify({catalog,result}), presentation=present(catalog,result);
  assert.equal(presentation.revisionId,catalog.revisionId);
  assert.equal(presentation.explanationCatalogId,catalog.explanationCatalogId);
  const shown=presentation.dimensions.find(d=>d.dimension===zeroRow.dimension)!;
  assert.equal(shown.summary.text,`保存值：0 (${zero.unit})`);
  assert.deepEqual(shown.summary.evidenceRows,[zeroRow]);
  assert.equal(presentation.synthesis.limitations[1].text,`待确认：未知 (${unknown.unit})${contextRow.context[key]??'未知'}`);
  assert.deepEqual(presentation.synthesis.limitations[1].evidenceRows,result.synthesis.limitations[1].evidenceRowIds.map(id=>catalog.rows.find(r=>r.id===id)));
  for(const dimension of presentation.dimensions) assert.deepEqual(dimension.limitations[0].limitations,catalog.limitations);
  assert.equal(JSON.stringify({catalog,result}),before);
  const {MarketShapeExplanationPresentationSchema:schema}=await import('../../shared/market-shape-explanation-presentation');
  assert.deepEqual(schema.parse(presentation),presentation);
  assert.equal(schema.safeParse({...presentation,html:'unsafe'}).success,false);
  const extra=structuredClone(presentation); Object.assign(extra.synthesis.summary,{html:'unsafe'});
  assert.equal(schema.safeParse(extra).success,false);
  assert.equal(presentation.dimensions.length,6);
});

test('presentation rejects wrong revision, bad references, arbitrary numbers, omitted limitations and changed catalog', async () => {
  const present=await implementation(), {catalog,result}=await fixture();
  const mutations:Array<(value:MarketShapeExplanationOutput)=>void>=[
    v=>{v.revisionId='market-shape-revision:'+'f'.repeat(64)},
    v=>{v.explanationCatalogId='market-shape-explanation:'+'f'.repeat(64)},
    v=>{v.synthesis.summary.evidenceRowIds=['foreign']},
    v=>{v.synthesis.summary.parts.push({kind:'cell',rowId:catalog.rows[0].id,cellId:'foreign'});v.synthesis.summary.evidenceRowIds=[catalog.rows[0].id]},
    v=>{v.synthesis.summary.parts.push({kind:'context',rowId:catalog.rows[0].id,key:'foreign'});v.synthesis.summary.evidenceRowIds=[catalog.rows[0].id]},
    v=>{v.synthesis.summary.parts=[{kind:'text',text:'销量999'}]},
    v=>{v.synthesis.summary.limitationCodes=['foreign']},
    v=>{v.dimensions[0].status='explained'},
    v=>{for(const s of [...v.dimensions.flatMap(d=>[d.summary,...d.limitations,...d.verification]),v.synthesis.summary,...v.synthesis.limitations,...v.synthesis.verification]) s.limitationCodes=[]},
  ];
  for(const mutate of mutations) { const invalid=structuredClone(result);mutate(invalid);assert.throws(()=>present(catalog,invalid)); }
  const altered=structuredClone(catalog);altered.rows[0].cells[0].value=999;
  assert.throws(()=>present(altered,result));
});

test('pure report renders six dimensions, insufficient conclusion, kinds and expandable unmodified source text safely', async () => {
  const present=await implementation(), source=await fixture();
  const catalog=structuredClone(source.catalog);
  const row=catalog.rows.find(r=>r.cells.some(c=>c.value!==null))!,cell=row.cells.find(c=>c.value!==null)!;
  row.context['source-name']='<img src=x onerror=alert("context")>';
  row.context['missing-context']=null;
  catalog.limitations[0].detail='<svg onload=alert("limitation")>\n保留来源限制原文';
  const {explanationCatalogId:oldId,...body}=catalog;
  catalog.explanationCatalogId='market-shape-explanation:'+canonicalJsonSha256(body);
  assert.notEqual(catalog.explanationCatalogId,oldId);
  const result=output(catalog);
  const section=result.dimensions.find(d=>d.dimension===row.dimension)!;
  const observed:MarketShapeExplanationStatement={kind:'observed',parts:[{kind:'text',text:'保存的值：'},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]};
  section.status='explained';section.summary=observed;section.findings=[observed,{...observed,kind:'inferred',parts:[{kind:'text',text:'来源名：'},{kind:'context',rowId:row.id,key:'source-name'},{kind:'context',rowId:row.id,key:'missing-context'}]}];
  result.synthesis.summary.parts=[{kind:'text',text:'<script>alert("unsafe")</script>'}];
  const presentation=present(catalog,result);
  const {MarketShapeExplanationReport}=await import('../../app/market-shape-explanation-report');
  const html=renderToStaticMarkup(createElement(MarketShapeExplanationReport,{presentation}));
  for(const label of ['分析范围','形态结构','价格带','品牌结构','上架年龄','月度变化','综合判断','证据不足','风险与限制','待验证','观测','推断']) assert.ok(html.includes(label),label);
  for(const tag of ['script','img','svg']) { assert.ok(html.includes(`&lt;${tag}`));assert.ok(!html.includes(`<${tag}`)); }
  assert.ok(html.includes('保留来源限制原文'));
  assert.equal(presentation.dimensions.find(d=>d.dimension===row.dimension)!.findings[1].text,`来源名：${row.context['source-name']}未知`);
  assert.ok(html.includes('<details>'));
  assert.ok(html.includes('overflow-wrap:anywhere'));
  for(const limitation of catalog.limitations) assert.ok(html.includes(limitation.code));
  assert.ok(!html.includes('分析成功'));
});
