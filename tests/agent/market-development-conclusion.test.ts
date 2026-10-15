import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDevelopmentConclusion,reviewDevelopmentEvidence} from '../../server/domain/market-research/development-conclusion';
import type {ConclusionEvidence} from '../../shared/market-development-conclusion';
const scope={marketplace:'US',nodeIdPath:'1:13280971',fromMonth:'2026-08',toMonth:'2026-08'};
const evidence=(module:ConclusionEvidence['module'],extra:Partial<ConclusionEvidence>={}):ConclusionEvidence=>({module,runId:'10000000-0000-4000-8000-000000000001',identity:module+'-frozen-v1',scope,status:'ready',facts:['已保存的样本事实'],findings:['按样本验证设计'],gaps:[],refs:[module+'-source'],...extra});
for(const [name,other] of Object.entries({country:{...scope,marketplace:'DE'},category:{...scope,nodeIdPath:'1:999'},month:{...scope,toMonth:'2026-09'}}))test(`unified conclusion excludes ${name} mismatch`,()=>{
 const result=buildDevelopmentConclusion('linked',scope,[evidence('overview'),evidence('keywords',{scope:other,findings:['禁止混入的结论']})]);
 assert.equal(result.evidence[1].status,'mismatch');assert.ok(result.gaps.some(g=>g.includes('范围')));assert.doesNotMatch(JSON.stringify(result.sections),/禁止混入/);
});
test('full path and leaf category identities match, but research windows must match exactly',()=>{const result=buildDevelopmentConclusion('linked',scope,[evidence('overview',{scope:{...scope,nodeIdPath:'13280971'}})]);assert.notEqual(result.evidence[0].status,'mismatch');});
test('four complete modules do not imply commercial approval or add a synthetic score',()=>{
 const result=buildDevelopmentConclusion('linked',scope,['overview','shapes','keywords','themes'].map(m=>evidence(m as ConclusionEvidence['module'])));
 assert.equal(result.status,'evidence-ready');assert.ok(result.actions.some(a=>a.priority==='P0'&&a.validation.includes('成本')));assert.match(result.headline,/验证/);assert.equal('score' in result,false);
});
test('failed and missing modules retain known results independently',()=>{const result=buildDevelopmentConclusion('linked',scope,[evidence('overview'),evidence('themes',{status:'missing',identity:null,facts:[],findings:[],gaps:['额度不足']})]);assert.equal(result.status,'partial');assert.ok(result.sections.some(s=>s.text.includes('已保存的样本事实')));assert.ok(result.gaps.some(g=>g.includes('额度不足')));});
test('review conclusion uses selected samples, positive/negative counts, and source refs without inventing review incidence',()=>{
 const input={scope,runId:'10000000-0000-4000-8000-000000000001',identity:'manual-v2',selectedCount:2,successfulCount:1,requestedCount:2,groups:[{label:'折叠结构',positive:9,negative:3,mention:10,share:50,asins:['B000000001'],refs:['theme-one']}],gaps:['1个样本未返回摘要']};
 const result=reviewDevelopmentEvidence(input);assert.equal(result.status,'partial');assert.match(result.findings.join(' '),/折叠结构/);assert.match(result.findings.join(' '),/9.*3/);assert.doesNotMatch(result.findings.join(' '),/90%|30%/);assert.equal(result.identity,'manual-v2');
 const report=buildDevelopmentConclusion('reviews',scope,[result]);assert.ok(report.actions.some(a=>a.refs.includes('theme-one')));assert.ok(report.gaps.some(g=>g.includes('去重')));
});
test('no review evidence cannot turn into an invented product recommendation',()=>{const e=reviewDevelopmentEvidence({scope,runId:null,identity:null,selectedCount:0,successfulCount:0,requestedCount:20,groups:[],gaps:[]});const report=buildDevelopmentConclusion('reviews',scope,[e]);assert.equal(report.status,'no-data');assert.equal(report.sections.filter(s=>s.status==='candidate').length,0);});
