import assert from 'node:assert/strict';
import test from 'node:test';
import {validateOverviewAnalysis} from '../../server/domain/market-research/overview-analysis-validation';

const input={analysisBrief:{mode:'synthesis',scopeStatement:'返回样本，非全市场；月份仅请求绑定',dimensions:[{id:'price',label:'价格结构',factIds:['price-fact'],gapIds:[]},{id:'demand',label:'需求趋势',factIds:[],gapIds:['demand-gap']}],factLabels:[{factId:'price-fact',label:'价格区间'}]},
  facts:[{factId:'price-fact',metricRefs:['price-share'],sourceRefs:['s-price']}],metrics:[{metricId:'price-share',value:60}],gaps:[{gapId:'demand-gap',sourceRefs:['s-demand']}]};
const statement=(text:string,factIds:string[]=[],gapIds:string[]=[])=>({parts:[{kind:'text',text}],factIds,gapIds});
const output={dimensions:[{dimensionId:'price',data:{parts:[{kind:'fact-label',factId:'price-fact'},{kind:'metric',metricId:'price-share'},{kind:'text',text:'为该区间在返回样本中的销量占比'}],factIds:['price-fact'],gapIds:[]},meaning:statement('份额集中提示定价竞争需要进一步核查',['price-fact']),conclusion:statement('先验证差异化空间，不能据样本直接立项',['price-fact']),limitations:[],verification:[statement('核对同区间商品的功能与成本',['price-fact'])]},
  {dimensionId:'demand',data:statement('本次没有需求趋势证据',[],['demand-gap']),meaning:statement('不能据成交样本推断搜索需求',[],['demand-gap']),conclusion:statement('需求增长尚待验证',[],['demand-gap']),limitations:[statement('需求来源本次为空',[],['demand-gap'])],verification:[statement('补充可比期间的需求来源',[],['demand-gap'])]}],summary:{decision:'insufficient-evidence',statement:statement('价格结构可供探索，但需求缺口限制进入判断',['price-fact'],['demand-gap'])}};
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));

test('analysis retains original prose and resolves numbers through cited facts',()=>{
  assert.deepEqual(validateOverviewAnalysis(input,output),output);
});
test('analysis rejects missing dimensions, invented references, free numbers and cross-dimension evidence',()=>{
  const cases:Array<(o:any)=>void>=[o=>o.dimensions.pop(),o=>o.dimensions.push(o.dimensions[0]),o=>o.dimensions[0].data.factIds=['invented'],o=>o.dimensions[0].data.parts[1].metricId='invented',o=>o.dimensions[0].data.parts[2].text='销量占比99%',o=>o.dimensions[0].data.parts[2].text='占九成',o=>o.dimensions[0].data.parts.shift(),o=>o.dimensions[0].data.gapIds=['demand-gap'],o=>o.dimensions[1].limitations=[],o=>o.summary.statement.factIds=['invented']];
  for(const mutate of cases){const o=clone(output);mutate(o);assert.throws(()=>validateOverviewAnalysis(input,o));}
});
test('source instructions and quantitative labels must not become fabricated numeric prose',()=>{
  const o=clone(output);o.dimensions[0].data.parts[0]={kind:'fact-label',factId:'price-fact'} as any;assert.doesNotThrow(()=>validateOverviewAnalysis(input,o));
  (o.dimensions[0].data.parts[0] as any).factId='demand-gap';assert.throws(()=>validateOverviewAnalysis(input,o));
  assert.throws(()=>validateOverviewAnalysis({...input,analysisBrief:undefined},output));assert.throws(()=>validateOverviewAnalysis(input,undefined));
});
