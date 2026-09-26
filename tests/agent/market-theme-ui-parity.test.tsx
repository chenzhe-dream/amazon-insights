import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketThemeSection, MarketThemeStepStatus } from '../../app/market-theme-section';
import {MarketThemeSourceIssueSchema} from '../../shared/market-theme-source-issue';
import { themeRunLabel } from '../../app/market-theme-section';
import { MarketThemeReport } from '../../app/market-theme-report';
import { ThemeEvidenceContent } from '../../app/market-theme-evidence';
import { themePresentationStatus } from '../../app/market-theme-insight-panel';
import { MarketThemeTopicTable, MarketThemeSampleTable, selectThemeSentiment } from '../../app/market-theme-insight-panel';
import { themeDetails, themeEntry, themeEvidence, themeRuleEntry, themeRuleRun } from './helpers/market-theme-page-fixture';

test('source count failure names the affected row and preserves the saved report semantics',()=>{
 const sourceIssue=MarketThemeSourceIssueSchema.parse({code:'count-exceeds-mention',themeIndex:1,field:'negative'});
 const step={...themeRuleRun().run.steps[0],status:'failed' as const,errorCode:'invalid-data' as const,sourceIssue};
 const html=renderToStaticMarkup(<MarketThemeStepStatus step={step}/>);
 assert.match(html,/第 2 条主题的负面提及数超过总提及数/);assert.match(html,/该商品未纳入本次统计/);
 const repaired=renderToStaticMarkup(<MarketThemeStepStatus step={{...step,status:'succeeded',errorCode:null}}/>);
 assert.doesNotMatch(repaired,/超过|未纳入/);
 const old=renderToStaticMarkup(<MarketThemeStepStatus step={{...step,sourceIssue:undefined}}/>);
 assert.match(old,/返回数据未通过校验/);assert.doesNotMatch(old,/第 2 条/);
 assert.equal(MarketThemeSourceIssueSchema.safeParse({...sourceIssue,raw:'private upstream content'}).success,false);
 assert.equal(MarketThemeSourceIssueSchema.safeParse({...sourceIssue,field:'authorization'}).success,false);
});

const details=(section:string)=>themeDetails(new URL(`https://test.invalid/reports/${themeEntry().attemptId}/details?section=${section}`));
test('theme query keeps reference site chips and category search composition without enabling unsupported sites',()=>{
 const html=renderToStaticMarkup(<MarketThemeSection maxMonth="2026-08"/>);
 assert.match(html,/ss-market-query--lilac/);assert.match(html,/ss-market-query-highlight/);assert.match(html,/ss-market-node-field/);
 assert.match(html,/拉取见解/);assert.match(html,/ss-market-chip selected/);assert.doesNotMatch(html,/disabled=""[^>]*>英国站/);
 assert.match(html,/等待指定类目节点/);assert.doesNotMatch(html,/TOP20/);
});
test('reference theme table keeps the report denominator and labels summary evidence honestly',()=>{
 const group=details('groups').page.items[0];assert.equal(group.kind,'group');if(group.kind!=='group')return;
 const html=renderToStaticMarkup(<MarketThemeTopicTable groups={[group]} entry={themeEntry()} evidence={{}}/>);
 assert.match(html,/category-cs-table/);for(const heading of ['主题','提及占比','覆盖 ASIN','评论摘要'])assert.match(html,new RegExp(`<th>${heading}</th>`));
 assert.match(html,/50.0%/);assert.match(html,/2\/4/);assert.match(html,/摘要/);assert.doesNotMatch(html,/B0THEME002/);
 const unknown={...group,topicShare:{...group.topicShare,valuePct:null,denominator:0}};
 assert.match(renderToStaticMarkup(<MarketThemeTopicTable groups={[unknown]} entry={themeEntry()} evidence={{}}/>),/未知/);
});
test('sentiment views preserve overlapping saved counts without inferring a dominant sentiment',()=>{
 const group=details('groups').page.items[0];if(group.kind!=='group')throw Error('fixture');
 const mixed={...group,index:1,totals:{...group.totals,positive:1,negative:1}};
 const neither={...group,index:2,totals:{...group.totals,positive:0,negative:0}};
 assert.deepEqual(selectThemeSentiment([group,mixed,neither],'positive'),[group,mixed]);assert.deepEqual(selectThemeSentiment([group,mixed,neither],'negative'),[mixed]);
 assert.equal(selectThemeSentiment([mixed],'negative')[0].topicShare.denominator,4);
});
test('sample table shows unknown titles, ranks and images without inventing source fields',()=>{
 const asins=details('asins').page.items.filter(item=>item.kind==='asin');
 const html=renderToStaticMarkup(<MarketThemeSampleTable asins={asins} marketplace="US"/>);
 assert.match(html,/category-cs-asin-table/);assert.match(html,/B0THEME002/);assert.match(html,/未提供/);assert.match(html,/采集失败/);assert.doesNotMatch(html,/<img/);assert.match(html,/disabled=""/);
});

test('theme topic and sample product links retain the saved UK and JP marketplace',()=>{
 const group=details('groups').page.items[0];if(group.kind!=='group')throw Error('fixture');
 const members=details('members').page.items.filter(item=>item.kind==='member'),asins=details('asins').page.items.filter(item=>item.kind==='asin');
 for(const [marketplace,domain] of [['UK','amazon.co.uk'],['JP','amazon.co.jp']] as const){
  const entry=themeEntry();entry.report.scope.marketplace=marketplace;
  const topic=renderToStaticMarkup(<MarketThemeTopicTable groups={[group]} entry={entry} evidence={{[group.index]:{members}}}/>);
  const sample=renderToStaticMarkup(<MarketThemeSampleTable asins={asins} marketplace={marketplace}/>);
  assert.ok(topic.includes(`https://www.${domain}/dp/B0THEME001`));
  assert.ok(sample.includes(`https://www.${domain}/dp/B0THEME002`));
  assert.ok(!`${topic}${sample}`.includes('www.amazon.com/'));
 }
});

test('rules-only theme report presents source facts as complete without claiming model analysis',()=>{
 const entry=themeRuleEntry();
 const html=renderToStaticMarkup(<MarketThemeReport entry={entry}/>);
 assert.equal(themeRunLabel(themeRuleRun().run),'规则报告已保存');
 assert.match(html,/规则数据已完整/);
 assert.match(html,/原主题条目/);
 assert.match(html,/语义归组未启用/);
 assert.doesNotMatch(html,/已校验的模型成员|模型结果不可用|部分主题的模型分析未完成/);
 const evidence=themeEvidence(new URL(`https://test.invalid/reports/${entry.attemptId}/evidence`)).evidence;
 evidence.analysis=null;
 const detail=renderToStaticMarkup(<ThemeEvidenceContent value={evidence} semanticSkipped/>);
 assert.match(detail,/此任务未启用语义归组/);
 assert.doesNotMatch(detail,/已保存的模型分析|模型结果不可用/);
});

test('old rules-only revisions display saved source coverage while retaining their frozen v1 payload',()=>{
 const prior={status:'partial' as const,selectedAsins:['B0THEME001','B0THEME002'],baseSelectionShortfall:false,asins:[{status:'success' as const},{status:'success' as const}]};
 assert.equal(themePresentationStatus(themeRuleEntry(),prior),'complete');
 assert.equal(themePresentationStatus(themeEntry(),prior),'partial');
 assert.equal(themePresentationStatus(themeRuleEntry(),{...prior,asins:[prior.asins[0],{status:'failed'}]}),'partial');
 const old=themeRuleRun().run,oldEntry=themeRuleEntry();oldEntry.report.reportVersion='market-theme-report/v1';oldEntry.report.versions.planner='market-theme-flow/rules-v1';oldEntry.report.status='partial';oldEntry.report.reasons=['model-results-missing'];
 old.currentReport=oldEntry;
 assert.equal(themeRunLabel(old),'规则报告已保存');
});
