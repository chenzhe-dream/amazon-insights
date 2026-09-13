import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceCatalog } from './helpers/market-shape-explanation-fixture';
import { buildMarketShapeExplanationCatalog } from '../../server/domain/market-research/shape-explanation-catalog';
import { validateMarketShapeExplanation, renderMarketShapeExplanationStatement } from '../../server/domain/market-research/shape-explanation-validation';
import { SHAPE_EXPLANATION_DIMENSIONS, type MarketShapeExplanationOutput, type MarketShapeExplanationStatement } from '../../shared/market-shape-explanation-output-contracts';
import type { MarketShapeExplanationCatalog } from '../../shared/market-shape-explanation-contracts';

function fixtureOutput(c: MarketShapeExplanationCatalog): MarketShapeExplanationOutput {
  const codes = c.limitations.map(item => item.code);
  const risk = (): MarketShapeExplanationStatement => ({kind:'risk',parts:[{kind:'text',text:'仅描述固定样本，来源和分类边界限制结论。'}],evidenceRowIds:[],limitationCodes:codes});
  const verify = (): MarketShapeExplanationStatement => ({...risk(),kind:'verification',parts:[{kind:'text',text:'核对来源、分类和后续完整周期再验证。'}]});
  const dimensions = SHAPE_EXPLANATION_DIMENSIONS.map(dimension => {
    const row = c.rows.find(row => row.dimension === dimension && row.cells.some(cell => cell.value !== null));
    const cell = row?.cells.find(cell => cell.value !== null);
    const finding: MarketShapeExplanationStatement = row && cell ? {kind:'observed',parts:[{kind:'text',text:'已保存样本指标为'},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]} : risk();
    return {dimension,status:row?'explained' as const:'insufficient-evidence' as const,summary:finding,findings:row?[finding]:[],limitations:[risk()],verification:[verify()]};
  });
  const distinctRows = SHAPE_EXPLANATION_DIMENSIONS.map(d => c.rows.find(row => row.dimension === d && row.cells.some(cell => cell.value !== null))).filter(Boolean);
  return {version:'market-shape-explanation-output/v1',explanationCatalogId:c.explanationCatalogId,revisionId:c.revisionId,dimensions,
    synthesis:{decision:'mixed-signals',summary:{kind:'inferred',parts:[{kind:'text',text:'样本结构需交叉验证，指标参照：'},...distinctRows.map(r=>({kind:'cell' as const,rowId:r!.id,cellId:r!.cells.find(c=>c.value!==null)!.id}))],evidenceRowIds:distinctRows.map(r=>r!.id),limitationCodes:codes},limitations:[risk()],verification:[verify()]}};
}
async function fixture() { const c=buildMarketShapeExplanationCatalog(await sourceCatalog());return {c,o:fixtureOutput(c)}; }

test('saved unequal groups validate with all dimensions and render server numbers including zero', async () => {
  const {c,o}=await fixture();const before=JSON.stringify(c);
  const result=validateMarketShapeExplanation(c,o);assert.equal(result.dimensions.length,6);
  const row=c.rows.find(r=>r.cells.some(cell=>cell.value===0))!,cell=row.cells.find(cell=>cell.value===0)!;
  o.dimensions.find(d=>d.dimension===row.dimension)!.summary={kind:'observed',parts:[{kind:'text',text:'已保存数值：'},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]};
  const text=renderMarketShapeExplanationStatement(c,o,{dimension:row.dimension,section:'summary'});
  assert.equal(text,`已保存数值：0 (${cell.unit})`);assert.equal(JSON.stringify(c),before);
});

test('cross revision, foreign row/cell, omitted dimension and free numeric prose are rejected', async () => {
  const {c,o}=await fixture();
  const mutations: Array<(x:MarketShapeExplanationOutput)=>void> = [
    x=>{x.revisionId='market-shape-revision:'+'f'.repeat(64)},
    x=>{x.explanationCatalogId='market-shape-explanation:'+'f'.repeat(64)},
    x=>{x.dimensions[0].summary.evidenceRowIds=['foreign']},
    x=>{const part=x.dimensions[0].summary.parts.find(p=>p.kind==='cell')!;if(part.kind==='cell')part.cellId='foreign'},
    x=>{x.dimensions[1].dimension='scope'},
    x=>{x.dimensions.pop()},
    x=>{x.dimensions[0].summary.parts=[{kind:'text',text:'销量增长999倍'}]},
    x=>{const row=c.rows.find(r=>r.dimension==='price')!;x.dimensions[0].summary={kind:'inferred',parts:[{kind:'text',text:'结构差异'}],evidenceRowIds:[row.id],limitationCodes:[]}},
    x=>{x.dimensions[0].findings=[]},
    x=>{x.synthesis.summary.limitationCodes=['made-up']},
  ];
  for(const mutate of mutations){const copy=structuredClone(o);mutate(copy);assert.throws(()=>validateMarketShapeExplanation(c,copy));}
});

test('unknown numeric values cannot support observed claims and legacy missing structures stay insufficient',async()=>{
  const {c,o}=await fixture();const row=c.rows.find(r=>r.cells.some(cell=>cell.value===null))!,cell=row.cells.find(cell=>cell.value===null)!;
  const claim:MarketShapeExplanationStatement={kind:'observed',parts:[{kind:'text',text:'已知值：'},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]};
  o.dimensions.find(d=>d.dimension===row.dimension)!.findings=[claim];assert.throws(()=>validateMarketShapeExplanation(c,o),/Unknown cell/);
  const riskOutput=fixtureOutput(c);riskOutput.dimensions.find(d=>d.dimension===row.dimension)!.limitations.push({...claim,kind:'risk'});
  assert.equal(renderMarketShapeExplanationStatement(c,riskOutput,{dimension:row.dimension,section:'limitations',index:1}),'已知值：未知');
  const old=buildMarketShapeExplanationCatalog(await sourceCatalog('market-shape-price-catalog/v1'));const legacy=fixtureOutput(old);
  assert.equal(validateMarketShapeExplanation(old,legacy).dimensions.find(d=>d.dimension==='age')!.status,'insufficient-evidence');
  legacy.dimensions.find(d=>d.dimension==='age')!.status='explained';assert.throws(()=>validateMarketShapeExplanation(old,legacy));
});

test('essential input limitations cannot be silently dropped from the explanation',async()=>{
  const {c,o}=await fixture();assert.ok(c.limitations.length);
  for(const d of o.dimensions){d.summary.limitationCodes=[];for(const s of [...d.findings,...d.limitations,...d.verification]){s.limitationCodes=[];if(!s.evidenceRowIds.length)s.evidenceRowIds=[c.rows.find(r=>r.dimension===d.dimension)!.id];}}
  o.synthesis.summary.limitationCodes=[];for(const s of [...o.synthesis.limitations,...o.synthesis.verification]){s.limitationCodes=[];s.evidenceRowIds=[c.rows[0].id];}
  assert.throws(()=>validateMarketShapeExplanation(c,o),/limitation/i);
});

test('accepted output is immutable and source alteration invalidates its bound directory',async()=>{
  const {c,o}=await fixture();const saved=validateMarketShapeExplanation(c,o);
  assert.throws(()=>{saved.dimensions[0].summary.parts.push({kind:'text',text:'改变已验结论'})});
  const bad=structuredClone(c);bad.rows[0].cells[0].value=900;assert.throws(()=>validateMarketShapeExplanation(bad,o));
});


test('synthesis decision cannot borrow risk and verification references as its own evidence',async()=>{
  const {c,o}=await fixture();o.synthesis.summary.evidenceRowIds=[];o.synthesis.summary.parts=[{kind:'text',text:'需要综合判断。'}];
  o.synthesis.limitations[0].evidenceRowIds=[c.rows.find(r=>r.dimension==='shape')!.id];
  o.synthesis.verification[0].evidenceRowIds=[c.rows.find(r=>r.dimension==='price')!.id];
  assert.throws(()=>validateMarketShapeExplanation(c,o),/Synthesis/);
});

test('insufficient dimensions have a risk summary and no purported findings',async()=>{
  const {c,o}=await fixture();o.dimensions[0].status='insufficient-evidence';
  assert.throws(()=>validateMarketShapeExplanation(c,o),/Insufficient/);
  o.dimensions[0].findings=[];assert.throws(()=>validateMarketShapeExplanation(c,o),/Insufficient/);
});


test('rendering cannot use an old explanation against a different version with matching row identifiers',async()=>{
  const {c,o}=await fixture();const other=buildMarketShapeExplanationCatalog(await sourceCatalog('market-shape-price-catalog/v1'));
  assert.notEqual(other.explanationCatalogId,c.explanationCatalogId);
  assert.throws(()=>renderMarketShapeExplanationStatement(other,o,{dimension:'scope',section:'summary'}),/revision/);
});


test('a positive synthesis must display its known cross-dimension evidence, not pad row identifiers',async()=>{
  const {c,o}=await fixture();o.synthesis.summary.parts=[{kind:'text',text:'样本有值得探索的结构差异。'}];
  assert.throws(()=>validateMarketShapeExplanation(c,o),/Synthesis/);
});

test('synthesis insufficient and non-insufficient decisions have consistent statement roles',async()=>{
  const {c,o}=await fixture();o.synthesis.decision='insufficient-evidence';
  assert.throws(()=>validateMarketShapeExplanation(c,o),/Synthesis/);
  o.synthesis.summary.kind='risk';assert.doesNotThrow(()=>validateMarketShapeExplanation(c,o));
  o.synthesis.decision='competitive-risk';o.synthesis.summary.kind='verification';assert.throws(()=>validateMarketShapeExplanation(c,o),/Synthesis/);
});
