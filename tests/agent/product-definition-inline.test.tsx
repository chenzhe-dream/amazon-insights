import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineReportText, InlineDecisionContent } from '../../app/product-definition-inline';
import { buildAnalysisRuleTrace, buildProductContext, decideProductCandidate, type AnalysisInputScope } from '../../shared/product-structure-rules';

const scope: AnalysisInputScope = {organizationId:'org',projectId:'project',marketplace:'US',asins:['B0DDX8MYKQ','B0F23VR2S4'],inputRevision:'preview'};
function traceFixture() {
  const contexts=scope.asins.map((asin,index)=>buildProductContext({scope,asin,title:'Candle lamp',evidence:[{id:`source-${index}`,asin,scope:'asin',kind:'voc',text:index?'其他商品的独立反馈':'当前商品用于居家装饰与送礼',inputScope:scope}]}));
  const decisions=contexts.map((context,index)=>decideProductCandidate(context,{id:`candidate-${index}`,asin:scope.asins[index],kind:'fact',text:index?'其他商品的独立反馈':'当前商品用于居家装饰与送礼',sourceObservation:'audiences',evidenceRefs:[`source-${index}`]}));
  return buildAnalysisRuleTrace(contexts,decisions);
}

test('ASIN text keeps every original fragment once, including repeated ASIN occurrences',()=>{
  const text='为【[B0DDX8MYKQ] 居家装饰；[B0F23VR2S4] 香氛】在【[B0DDX8MYKQ] 客厅】使用';
  const html=renderToStaticMarkup(createElement(InlineReportText,{text,splitAsins:true,expandTogether:true}));
  assert.equal((html.match(/居家装饰/g)||[]).length,1);
  assert.equal((html.match(/B0DDX8MYKQ/g)||[]).length,2);
  for(const fragment of ['为【','香氛】在【','客厅】使用'])assert.ok(html.includes(fragment));
});

test('Chinese and English ASIN markers produce separate labels without changing text',()=>{
  const text='为【B0DDX8MYKQ】客厅；[B0F23VR2S4]卧室';
  const html=renderToStaticMarkup(createElement(InlineReportText,{text,splitAsins:true}));
  assert.equal((html.match(/class="definition-inline-asin-label"/g)||[]).length,2);
  assert.equal(html.replace(/<[^>]+>/g,''),text);
});

test('decision details only use requested candidates and their saved sources',()=>{
  const trace=traceFixture(),before=JSON.stringify(trace);
  const html=renderToStaticMarkup(createElement(InlineDecisionContent,{trace,decisionIds:['candidate-0']}));
  assert.ok(html.includes('当前商品用于居家装饰与送礼'));
  assert.ok(!html.includes('其他商品的独立反馈'));
  assert.ok(!html.includes('B0F23VR2S4'));
  assert.equal(JSON.stringify(trace),before);
});

test('missing historical trace and absent candidate do not invent a judgment',()=>{
  const missing=renderToStaticMarkup(createElement(InlineDecisionContent,{}));
  assert.ok(missing.includes('历史结果未记录规则版本'));
  const absent=renderToStaticMarkup(createElement(InlineDecisionContent,{trace:traceFixture(),decisionIds:['missing']}));
  assert.ok(absent.includes('没有保存判定明细'));
  assert.ok(!absent.includes('当前商品用于居家装饰与送礼'));
});

test('unknown conditions, checks and unavailable references remain visible',()=>{
  const trace=traceFixture();trace.decisions[0].matchedConditions.push({predicate:{op:'structure'},description:'实际结构尚未确认',passed:null});
  trace.decisions[0].checks=['核对适龄限制'];trace.decisions[0].evidenceRefs.push('missing-source');
  const html=renderToStaticMarkup(createElement(InlineDecisionContent,{trace,decisionIds:['candidate-0']}));
  for(const text of ['实际结构尚未确认','未知','核对适龄限制','来源不可用'])assert.ok(html.includes(text));
});

test('ambiguous sources and missing saved rule definitions do not use replacement evidence',()=>{
  const trace=traceFixture();
  trace.sources.push({...trace.sources[0],text:'不应展示的冲突来源'});
  trace.ruleDefinitions=[];
  const html=renderToStaticMarkup(createElement(InlineDecisionContent,{trace,decisionIds:['candidate-0']}));
  assert.ok(html.includes('来源不可用（source-0）'));
  assert.ok(!html.includes('不应展示的冲突来源'));
  assert.ok(html.includes('未保存对应版本规则定义'));
  assert.ok(!html.includes('Snow Sled'));
});
