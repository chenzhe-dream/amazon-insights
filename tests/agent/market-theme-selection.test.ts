import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateCustomerThemes } from '../../server/domain/market-research/customer-themes';
import { deriveThemeSelection, projectThemeSample } from '../../server/domain/market-research/customer-theme-selection';
const a='B000000001',b='B000000002';
export function selectionFacts(topN?:number){
 const results=[a,b].map((asin,i)=>({asin,status:'success' as const,source:{sourceRecordId:`s${i}`,fetchedAt:'2026-09-01T00:00:00.000Z',sourceUpdatedAt:null},themes:[{sourceThemeId:`t${i}`,keyword:'Assembly',content:'Saved summary',mention:i?30:10,positive:i?20:10,negative:i?20:10}]}));
 const mappings=results.map(r=>({sourceThemeId:r.themes[0].sourceThemeId,groupId:'assembly'}));
 return {aggregation:aggregateCustomerThemes({selectedAsins:[a,b],results,mappings,topN}),labels:[{groupId:'assembly',labelZh:'组装',definition:'组装体验',origin:'catalog' as const,batchId:null,proposalId:null}],decisions:mappings.map(m=>({...m,status:'mapped' as const,reason:null,batchId:null}))};
}
test('selection recomputes complete evidence, preserves overlap, restores and accepts no data without mutating the base',()=>{
 const facts=selectionFacts(),original=JSON.stringify(facts);
 const subset=deriveThemeSelection(facts,[b],false);
 assert.equal(subset.totals!.mention,10);assert.equal(subset.groups[0].topicShare.denominator,10);
 assert.equal(subset.totals!.positive+subset.totals!.negative,20);assert.equal(subset.status,'complete');
 assert.deepEqual(subset.selectedAsins,[a]);assert.equal(JSON.stringify(facts),original);
 assert.equal(deriveThemeSelection(facts,[],false).totals!.mention,40);
 const empty=deriveThemeSelection(facts,[a,b],false);assert.equal(empty.status,'no-data');assert.equal(empty.totals,null);
 assert.throws(()=>deriveThemeSelection(facts,['B000000003'],false));assert.throws(()=>deriveThemeSelection(facts,[a,a],false));
});
test('display truncation never drops denominator facts or unresolved mapping limits',()=>{
 const result=deriveThemeSelection(selectionFacts(0),[b],true);
 assert.equal(result.totals!.mention,10);assert.equal(result.groups.length,0);assert.equal(result.reconciliationRequired,true);assert.equal(result.status,'partial');
});

test('theme evidence takes three unique summaries from the full member set',()=>{
 const themes=[
  ['t1','重复摘要'],['t2','重复摘要'],['t3','重复摘要'],['t4','第二条摘要'],['t5','第三条摘要'],
 ].map(([sourceThemeId,content],i)=>({sourceThemeId,keyword:`主题 ${i+1}`,content,mention:10,positive:10,negative:0}));
 const mappings=themes.map(theme=>({sourceThemeId:theme.sourceThemeId,groupId:'same-group'}));
 const facts={aggregation:aggregateCustomerThemes({selectedAsins:[a],results:[{asin:a,status:'success' as const,source:{sourceRecordId:'source',fetchedAt:'2026-09-01T00:00:00.000Z',sourceUpdatedAt:null},themes}],mappings}),labels:[],decisions:themes.map(theme=>({sourceThemeId:theme.sourceThemeId,status:'unknown' as const,groupId:null,reason:'unconfirmed',batchId:null}))};
 const result=deriveThemeSelection(facts,[],false);
 assert.deepEqual(result.evidence[0].members.map(member=>member.content.text),['重复摘要','第二条摘要','第三条摘要']);
});

test('rules-only sample revision reports source coverage without treating skipped mapping as incomplete',()=>{
 const results=[a,b].map((asin,i)=>({asin,status:'success' as const,source:{sourceRecordId:`source-${i}`,fetchedAt:'2026-09-01T00:00:00.000Z',sourceUpdatedAt:null},themes:[{sourceThemeId:`raw-${i}`,keyword:'Assembly',content:'Saved summary',mention:i+1,positive:i+1,negative:0}]}));
 const aggregation=aggregateCustomerThemes({selectedAsins:[a,b],results,mappings:[]});
 const facts={aggregation,labels:[],decisions:results.map((_,i)=>({sourceThemeId:`raw-${i}`,status:'unavailable' as const,groupId:null,reason:'model-result-unavailable',batchId:null}))};
 assert.equal(deriveThemeSelection(facts,[],false,false,true).status,'complete');
 assert.equal(deriveThemeSelection(facts,[b],false,false,true).status,'complete');
 assert.equal(deriveThemeSelection(facts,[],false).status,'partial');
});

test('saved topN limits presentation without erasing sentiment counts through exclusions and restoration',()=>{
 const results=[a,b].map((asin,i)=>({asin,status:'success' as const,source:{sourceRecordId:`s${i}`,fetchedAt:'2026-09-01T00:00:00.000Z',sourceUpdatedAt:null},themes:[{sourceThemeId:`t${i}`,keyword:i?'Breakage':'Easy assembly',content:'Saved summary',mention:i?40:100,positive:i?0:100,negative:i?40:0}]}));
 const mappings=results.map(r=>({sourceThemeId:r.themes[0].sourceThemeId,groupId:r.themes[0].sourceThemeId}));
 const labels=mappings.map(m=>({groupId:m.groupId,labelZh:m.groupId,definition:'Saved group',origin:'catalog' as const,batchId:null,proposalId:null}));
 const decisions=mappings.map(m=>({...m,status:'mapped' as const,reason:null,batchId:null}));
 for(const topN of [undefined,1,0]){
  const facts={aggregation:aggregateCustomerThemes({selectedAsins:[a,b],results,mappings,topN}),labels,decisions},before=JSON.stringify(facts);
  const baseline=deriveThemeSelection(facts,[],false);
  assert.deepEqual(baseline.sentimentGroupCounts,{positive:1,negative:1},`topN=${topN}`);
  assert.equal(baseline.totals!.mention,140);assert.equal(baseline.totals!.negative,40);
  assert.equal(baseline.groups.length,topN??2);assert.equal(baseline.previewOmittedGroupCount,0);
  assert.deepEqual(baseline.display,{topN:topN??null,totalGroupCount:2,displayedGroupCount:topN??2,omittedGroupCount:2-(topN??2)});
  assert.ok(baseline.groups.every(g=>g.topicShare.denominator===140));
  const negativeOnly=deriveThemeSelection(facts,[a],false);
  assert.deepEqual(negativeOnly.sentimentGroupCounts,{positive:0,negative:1});assert.equal(negativeOnly.totals!.mention,40);
  assert.equal(negativeOnly.groups.length,topN===0?0:1);assert.equal(negativeOnly.display.omittedGroupCount,topN===0?1:0);
  assert.ok(negativeOnly.groups.every(g=>g.topicShare.denominator===40));
  assert.deepEqual(deriveThemeSelection(facts,[b],false).sentimentGroupCounts,{positive:1,negative:0});
  assert.deepEqual(deriveThemeSelection(facts,[],false),baseline);assert.equal(JSON.stringify(facts),before);
 }
});
test('metadata validates frozen row identity, distinguishes row order from rank and never invents an image',()=>{
 const sample=projectThemeSample({asin:a,sourceIndex:0,product:{asin:a,title:'Lamp',sourceRank:9},productSource:{ref:'market-source:'+ 'a'.repeat(64),snapshotId:'market-input:'+ 'b'.repeat(64),payload:{data:[{asin:a,title:'Lamp',ranking:9}]}}});
 assert.equal(sample.title.value,'Lamp');assert.equal(sample.sourceRank.value,9);assert.equal(sample.sourceOrder,1);assert.equal(sample.imageUrl.value,null);
 assert.throws(()=>projectThemeSample({asin:a,sourceIndex:0,product:{asin:a,title:'Lamp',sourceRank:9},productSource:{ref:'market-source:'+ 'a'.repeat(64),snapshotId:'market-input:'+ 'b'.repeat(64),payload:{data:[{asin:b,title:'Lamp',ranking:9}]}}}));
});

test('metadata follows collector ASIN/text normalization and numeric-string ranks',()=>{
 const make=(raw:unknown,title:string|null,rank:number|null)=>projectThemeSample({asin:a,sourceIndex:0,product:{asin:a,title,sourceRank:rank},productSource:{ref:'market-source:'+'a'.repeat(64),snapshotId:'market-input:'+'b'.repeat(64),payload:{data:[raw]}}});
 const normalized=make({asin:' b000000001 ',title:'  Lamp  ',ranking:'9'},'Lamp',9);assert.equal(normalized.title.value,'Lamp');assert.equal(normalized.sourceRank.value,9);
 const missing=make({asin:a,title:' ',ranking:null},null,null);assert.equal(missing.title.value,null);assert.ok(missing.title.missingReason);assert.equal(missing.sourceRank.value,null);
});

test('2001 valid source groups retain the full denominator behind bounded presentation',()=>{
 const themes=Array.from({length:2001},(_,i)=>({sourceThemeId:`large-${String(i).padStart(4,'0')}`,keyword:`Topic ${i}`,content:'Saved',mention:1,positive:1,negative:0}));
 const aggregation=aggregateCustomerThemes({selectedAsins:[a],results:[{asin:a,status:'success',source:{sourceRecordId:'large',fetchedAt:'2026-09-01T00:00:00.000Z',sourceUpdatedAt:null},themes}],mappings:[]});
 const facts={aggregation,labels:[],decisions:themes.map(t=>({sourceThemeId:t.sourceThemeId,status:'unknown' as const,groupId:null,reason:'unconfirmed',batchId:null}))};
 const result=deriveThemeSelection(facts,[],false);assert.equal(result.totals!.mention,2001);assert.equal(result.groups.length,12);assert.equal(result.groups[0].topicShare.denominator,2001);assert.equal(result.display.totalGroupCount,2001);assert.equal(result.sentimentGroupCounts.positive,2001);assert.equal(result.previewOmittedGroupCount,1989);
 assert.equal(deriveThemeSelection(facts,[a],false).totals,null);
});

test('large UTF8 and escaped text stays within the public result byte budget without truncating arithmetic',()=>{
 const themes=Array.from({length:200},(_,i)=>({sourceThemeId:`wide-${i}`,keyword:'装'.repeat(2000),content:'\u0000'.repeat(10000),mention:1,positive:1,negative:1}));
 const aggregation=aggregateCustomerThemes({selectedAsins:[a],results:[{asin:a,status:'success',source:{sourceRecordId:'wide',fetchedAt:'2026-09-01T00:00:00.000Z',sourceUpdatedAt:null},themes}],mappings:[]});
 const result=deriveThemeSelection({aggregation,labels:[],decisions:themes.map(t=>({sourceThemeId:t.sourceThemeId,status:'unknown' as const,groupId:null,reason:'unconfirmed',batchId:null}))},[],false);
 assert.equal(result.totals!.mention,200);assert.equal(result.sentimentGroupCounts.positive,200);assert.ok(Buffer.byteLength(JSON.stringify(result),'utf8')<=160000);assert.ok(result.previewOmittedGroupCount>0);assert.ok(result.groups.every(g=>g.topicShare.denominator===200));
});

test('complete public view stays under the real proxy budget with 1000 history headers and 20 text-heavy samples',async()=>{
 const {MarketThemeSelectionResponseSchema}=await import('../../shared/market-theme-selection-contracts');const {themeEntry}=await import('./helpers/market-theme-page-fixture');
 const result=deriveThemeSelection(selectionFacts(),[],false),base=themeEntry();
 const samples=Array.from({length:20},(_,i)=>{const asin=`B${String(i).padStart(9,'0')}`,title='\u0000'.repeat(2000);return projectThemeSample({asin,sourceIndex:0,product:{asin,title,sourceRank:1},productSource:{ref:'market-source:'+'a'.repeat(64),snapshotId:'market-input:'+'b'.repeat(64),payload:{data:[{asin,title,ranking:1}]}},summarySource:{ref:'market-source:'+'c'.repeat(64),snapshotId:'market-input:'+'d'.repeat(64),payload:{data:{customer_say:'\u0000'.repeat(10000)}}}});});
 const history=Array.from({length:1000},(_,i)=>({revisionId:`market-theme-selection-revision:${i.toString(16).padStart(64,'0')}`,ordinal:i+1,createdAt:'2026-09-16T00:00:00.000Z',resultHash:'a'.repeat(64)}));
 const revision={...history[999],parentRevisionId:history[998].revisionId,authorId:base.report.scope.organizationId,baseReportAttemptId:base.attemptId,baseReportHash:base.report.reportHash,note:'\u0000'.repeat(500),result};
 const view=MarketThemeSelectionResponseSchema.parse({version:'market-theme-selection-view/v1',base,samples,baseline:result,latestRevisionId:revision.revisionId,revision,history});
 assert.ok(samples.every(s=>s.title.truncated&&s.customerSay.truncated));
 // Replace both small results with the maximum permitted derived-result byte budget.
 const nonResultBytes=Buffer.byteLength(JSON.stringify({...view,baseline:null,revision:{...revision,result:null}}),'utf8');assert.ok(nonResultBytes+2*160000<900000,`Total response upper bound ${nonResultBytes+320000}`);
});
