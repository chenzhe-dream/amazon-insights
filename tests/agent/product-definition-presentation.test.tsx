import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { presentDefinitionConclusion, presentDefinitionCard } from '../../app/lib/product-definition-presentation';
import { ActionStepsCell } from '../../app/action-steps-cell';
import type { FinalDefinitionRow } from '../../app/final-product-definition';
import type { AnalysisRuleTrace } from '../../shared/product-structure-rules';
import { buildProductLaunchAnalysis } from '../../app/product-launch-analysis';
import { buildFinalProductDefinition } from '../../app/final-product-definition';
import { DefinitionConclusion } from '../../app/product-definition-conclusion';
import { ReportParagraphs } from '../../app/product-definition-conclusion';

function fixture() {
  const scope = {organizationId:'org',projectId:'project',marketplace:'US',asins:['B0DDX8MYKQ','B0F23VR2S4'],inputRevision:'saved'};
  const records = ['居家装饰爱好者｜约占25%；代表评论：Perfect addition to my living room', '香氛爱好者｜约占30%；代表评论：Scent throw stronger'];
  const trace: AnalysisRuleTrace = {ruleSetVersion:'saved-version',ruleDefinitions:[],inputScope:scope,
    sources:records.map((text,i)=>({id:`s${i}`,asin:scope.asins[i],kind:'voc',scope:'asin',text,location:'audiences',inputScope:scope})),
    decisions:records.map((text,i)=>({candidateId:`voc-applicability:audiences:s${i}`,asin:scope.asins[i],kind:'fact',text,outcome:'supported',reasonCode:'voc_reported',summary:'VOC记录',checks:[],ruleSetVersion:'saved-version',ruleIds:[],ruleVersions:{},inputScope:scope,evidenceRefs:[`s${i}`],matchedConditions:[]}))};
  const row: FinalDefinitionRow = {dimension:'目标人群/年龄',conclusion:'完整原始结论；搜索人群线索：toddler',vocBasis:records.join('；'),keywordBasis:'toddler',action:'验证',priority:'P0',pending:'商品适龄待核对',ruleDecisionIds:trace.decisions.map(d=>d.candidateId)};
  return {trace,row};
}

test('conclusions use concise labels from own saved decisions, with per-product scope and no raw quotes or keyword audience',()=>{
  const {trace,row}=fixture(), before=JSON.stringify({trace,row});
  const result=presentDefinitionConclusion(row,trace);
  assert.deepEqual(result.points,['产品 1：居家装饰爱好者','产品 2：香氛爱好者']);
  assert.equal(result.summarized,true);
  assert.equal(result.productKeys[0].asin,'B0DDX8MYKQ');
  assert.doesNotMatch(result.points.join('；'),/Perfect|25%|VOC记录|toddler|B0DDX8MYKQ/);
  row.ruleDecisionIds=[trace.decisions[0].candidateId];
  assert.doesNotMatch(presentDefinitionConclusion(row,trace).points.join('；'),/香氛/);
  row.ruleDecisionIds=trace.decisions.map(d=>d.candidateId);
  assert.equal(JSON.stringify({trace,row}),before);
});

test('qualifications and rejected/conflicting/unknown observations are never reduced to positive labels',()=>{
  for(const reason of ['conditional','restricted','conflict','unknown']) {
    const {trace,row}=fixture();
    const text='儿童｜仅在成人监护时使用，不适合无人陪同；适龄待核对';
    trace.sources[0].text=text;trace.decisions[0].text=text;trace.decisions[0].reasonCode=`voc_${reason}`;
    const result=presentDefinitionConclusion(row,trace);
    assert.ok(result.warnings.some(w=>w.includes(text)));
    assert.ok(!result.points.some(p=>p.includes('儿童')));
  }
});

test('missing, duplicate, foreign and stale references fall back without borrowing facts',()=>{
  const mutations:Array<(trace:AnalysisRuleTrace)=>void>=[
    t=>{t.sources=[];}, t=>{t.sources.push({...t.sources[0]});},
    t=>{t.decisions.push({...t.decisions[0]});},
    t=>{t.decisions[0].inputScope={...t.inputScope,projectId:'other'};},
    t=>{t.sources[0].inputScope={...t.inputScope,marketplace:'UK'};},
    t=>{t.sources[0].asin=t.inputScope.asins[1];},
    t=>{t.decisions[0].ruleSetVersion='foreign-version';},
    t=>{t.sources[0].text='未经引用的新内容';},
  ];
  for(const mutate of mutations){const {trace,row}=fixture();mutate(trace);assert.deepEqual(presentDefinitionConclusion(row,trace).points,[row.conclusion]);}
  const {row}=fixture();assert.deepEqual(presentDefinitionConclusion(row).points,[row.conclusion]);
});

test('identical product forms deduplicate exactly, different structures and conditions remain separate',()=>{
  const {row}=fixture();row.dimension='产品形态';
  row.conclusion='【B0DDX8MYKQ】Candle Lamps；【B0F23VR2S4】Candle Lamps';
  assert.deepEqual(presentDefinitionConclusion(row).points,['Candle Lamps']);
  row.conclusion='【B0DDX8MYKQ】Snow Scooter（雪地））；【B0F23VR2S4】Scooter（轮式）';
  assert.deepEqual(presentDefinitionConclusion(row).points,[row.conclusion]);
});

test('opt-in actions expose all remaining items inline and keep restrictions outside disclosure',()=>{
  const value='产品：优化底座；包装：调整内衬；验证：复测稳定性；禁止用于冰面；仅限成人监督使用；待验证：复测温升；禁止：无人監护使用；验收：跌落后无开裂';
  const html=renderToStaticMarkup(createElement(ActionStepsCell,{value,maxItems:1,expandable:true}));
  assert.ok(html.includes('<details'));
  assert.ok(html.includes('调整内衬') && html.includes('复测稳定性'));
  assert.ok(html.indexOf('禁止用于冰面')<html.indexOf('<details'));
  assert.ok(html.indexOf('仅限成人监督使用')<html.indexOf('<details'));
  for(const text of ['复测温升','无人監护使用','跌落后无开裂']) assert.ok(html.indexOf(text)<html.indexOf('<details'));
  const old=renderToStaticMarkup(createElement(ActionStepsCell,{value,maxItems:1}));
  assert.ok(old.includes('见完整规格书') && !old.includes('<details'));
});

test('actual analysis pipeline produces concise labels despite its generic provenance check',()=>{
  const asin='B0DDX8MYKQ';
  const analysis=buildProductLaunchAnalysis([{asin,brand:'Fixture',title:'Candle warmer lamp',rankCategory:'Home & Kitchen',subRankCategory:'Candle Lamps'}],{
    keywordDemand:null,manualVocByAsin:{[asin]:{asin,attention:[],positives:[],negatives:[],unmet:[],audiences:['居家装饰爱好者｜约占25%；代表评论：Perfect addition to my living room'],scenarios:['客厅｜主要装饰，开放式使用'],motives:[],captureStatus:'dialog',alexaReport:{title:'Fixture',asin,captureStatus:'dialog',rating:4,reviewCount:100,prompt:'fixture',overallConclusion:'测试样例'}}}});
  const report=buildFinalProductDefinition({categoryLabel:analysis.meta.categoryLabel,productCount:1,dataMonth:analysis.meta.dataMonth,vocPositioning:analysis.vocPositioning,keyword:analysis.keywordConclusions,hasVocData:true});
  const row=report.definitionRows.find(r=>r.dimension==='目标人群/年龄')!;
  const result=presentDefinitionConclusion(row,report.ruleTrace);
  assert.equal(result.summarized,true);
  assert.deepEqual(result.points,['居家装饰爱好者']);
  assert.deepEqual(result.warnings,[]);
  assert.match(row.vocBasis,/Perfect addition/);
});

test('legacy fallback never clamps qualifications recognized by the existing applicability parser',()=>{
  for(const qualification of ['户外｜不应使用于雨天','儿童｜无法确认实际适龄','雪地｜可接受场景，备选使用']) {
    const {row}=fixture();row.conclusion='既有报告介绍。'.repeat(100)+qualification;
    const html=renderToStaticMarkup(createElement(DefinitionConclusion,{value:presentDefinitionConclusion(row)}));
    assert.ok(html.includes(qualification));
    assert.ok(!html.includes('definition-inline-copy'));
  }
  const {row,trace}=fixture();trace.decisions[0].matchedConditions.push({predicate:{op:'structure'},description:'必须有成人监护',passed:null});
  assert.ok(presentDefinitionConclusion(row,trace).warnings.some(w=>w.includes('必须有成人监护')));
});

test('overview cards reuse only exact matching saved rows and preserve old or mismatched card text',()=>{
  const {row,trace}=fixture();
  const card={key:'audience',value:row.vocBasis};
  const before=JSON.stringify({row,trace,card});
  assert.deepEqual(presentDefinitionCard(card,[row],trace)?.points,['产品 1：居家装饰爱好者','产品 2：香氛爱好者']);
  assert.equal(presentDefinitionCard({...card,value:'其他历史人群'},[row],trace),undefined);
  assert.equal(presentDefinitionCard(card,[row]),undefined);
  assert.equal(presentDefinitionCard(card,[row,{...row}],trace),undefined);
  assert.equal(presentDefinitionCard({...card,key:'pain'},[row],trace),undefined);
  assert.equal(JSON.stringify({row,trace,card}),before);
});

test('paragraph formatting preserves complete restrictions, delimiters and whitespace',()=>{
  const raw='仅限成人； 不可无人监护;\n验收：跌落测试后无开裂';
  const html=renderToStaticMarkup(createElement(ReportParagraphs,{text:raw}));
  assert.equal(html.replace(/<[^>]+>/g,''),raw);
  assert.ok(!html.includes('details') && !html.includes('definition-inline-copy'));
});
