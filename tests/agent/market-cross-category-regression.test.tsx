import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MarketShapeReferenceView} from '../../app/market-shape-reference/view';
import {buildReferenceSynthesisPresentation} from '../../app/market-shape-reference/conclusions/synthesis-presentation';
import {fixedShapeLabels} from '../../app/market-shape-reference/shape-catalog';
import type {SorftimeCategoryDashboardReport} from '../../app/market-shape-reference/types';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {buildKeywordOriginalEstimate} from '../../server/domain/market-research/keyword-original-estimate';
import {buildKeywordOriginalClassification} from '../../server/domain/market-research/keyword-original-classification';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';
import {MarketKeywordOriginalEstimateReport} from '../../app/market-keyword-original-estimate-report';
import {MarketKeywordFactsReport} from '../../app/market-keyword-report';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {aggregateCustomerThemes} from '../../server/domain/market-research/customer-themes';
import {deriveThemeSelection} from '../../server/domain/market-research/customer-theme-selection';
import {MarketThemeTopicTable} from '../../app/market-theme-result-view';
import {marketSiteCurrency,type MarketSite} from '../../shared/market-sites';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {projectMarketOverviewOriginalSynthesis} from '../../server/domain/market-research/overview-original-synthesis';
const specs=[
 {name:'Floor Lamps',seed:'floor lamp',site:'US',forms:['弧形落地灯','层架灯'],words:['dimmable floor lamp for living room','floor lamp for bedroom','floor lamp for reading']},
 {name:'Kick Scooters',seed:'kick scooter',site:'US',forms:['三轮滑板车','大两轮滑板车'],words:['kick scooter for kids','foldable kick scooter for adults','kick scooter light up wheels']},
 {name:'Swim Vests',seed:'swim vest',site:'US',forms:['背心式','连体式'],words:['swim vest for kids','swim vest for pool','adjustable swim vest for adults']},
 {name:'Storage Bins',seed:'storage bins',site:'US',forms:['带盖式','抽屉式'],words:['storage bins 10-20 liter','stackable storage bins for kitchen','plastic storage bins for closet']},
 {name:'Apple Slicers',seed:'apple slicer',site:'US',forms:['按压式','旋转式'],words:['apple slicer','apple slicer for kitchen','apple slicer with corer']},
 {name:'Stehlampen',seed:'Stehlampe',site:'DE',forms:['Bogenlampe','Leselampe'],words:['Stehlampe dimmbar','Stehlampe Wohnzimmer','Stehlampe mit Fernbedienung']},
] as const;
const results:any[]=[];
const checks:any[]=[];
function check(category:string,module:string,name:string,passed:boolean,details?:unknown){test(`${category}: ${module}: ${name}`,()=>assert.ok(passed,JSON.stringify(details)));}
for(const [ci,s] of specs.entries()){
 const site=s.site as MarketSite,node=`99000100${ci}`; // synthetic IDs, never sent to a supplier
 const asins=Array.from({length:150},(_,i)=>`B${String(ci*1000+i+1).padStart(9,'0')}`);
 const products=asins.map((asin,i)=>({rank:i+1,asin,title:`SYNTHETIC ${s.name} ${i+1}`,brand:`Brand ${i%7}`,imageUrl:'',monthlySalesVolume:100+ci*20+i,monthlySalesAmount:(100+ci*20+i)*(25+ci*5+i%5*10),sales:{last3Months:(100+ci*20+i)*3,last6Months:(100+ci*20+i)*6,y2024:(100+ci*20+i)*9,y2025:(100+ci*20+i)*10,monthsAvailable:30},monthlyTrend:{volume:[],amount:[]},price:25+ci*5+i%5*10,categoryRank:'',productCategory:s.name,productShape:s.forms[i%2],productShapeHint:null,bsrRank:i+1,deliveryType:'FBA',reviewCount:50+i,starRating:4.5,seller:`Seller ${i%8}`,sellerOrigin:site,onlineDate:'2023-01-01',grossProfitMargin:[45,55,65,75,85,60][ci],priceBand:`$${Math.floor((25+ci*5+i%5*10)/10)*10}-${Math.floor((25+ci*5+i%5*10)/10)*10+10}`}));
 const sum=(key:keyof typeof products[number]['sales'])=>products.reduce((n,p)=>n+p.sales[key],0);
 const report:SorftimeCategoryDashboardReport={calculationVersion:'shape-all-links/3',marketplace:site,sorftimeSite:site,nodeId:node,categoryName:s.name,fetchedAt:'2026-09-01T00:00:00.000Z',note:'SYNTHETIC AUDIT ONLY',products,topLinkCount:150,productSalesTotals:{last3Months:sum('last3Months'),last6Months:sum('last6Months'),y2024:sum('y2024'),y2025:sum('y2025'),monthsAvailable:30},stats:{top100MonthlyVolume:products.reduce((n,p)=>n+p.monthlySalesVolume,0),top100MonthlyAmount:products.reduce((n,p)=>n+p.monthlySalesAmount,0),top3ProductSharePct:10,top3BrandSharePct:40,top3SellerSharePct:35,amazonOwnedSharePct:0,averagePrice:45+ci*5,medianPrice:45+ci*5,returnRatePct:2},history:{volume:[],amount:[],avgPrice:[],listingMonopoly:[],brandMonopoly:[],sellerMonopoly:[]}};
 const before=JSON.stringify(report),fixed=fixedShapeLabels(s.name,node);
 const renderShape=(r:SorftimeCategoryDashboardReport)=>renderToStaticMarkup(<MarketShapeReferenceView report={r} assignments={{}} selectedAsins={r.products.map(p=>p.asin)} onAssignment={()=>{}} onSelected={()=>{}}/>);
 const full=buildReferenceSynthesisPresentation(report,{},asins,fixed),html=renderShape(report);
 check(s.name,'shape','seven-regions', ['类目销量看板','TOP 销售商品','上架年份','商品形态 · 销量占比','商品形态 · 价格带','品牌 · 价格带','类目商品链接调研 · 最终结论'].every(h=>html.includes(h)));
 check(s.name,'shape','full-five-dimensions-score',full.moduleSections.length===5&&full.score!==null,{score:full.score});
 for(const version of ['shape-reference/1','shape-known-coverage/2'] as const){ const historic={...structuredClone(report),calculationVersion:version}; check(s.name,'shape',`historical-${version}-five-dimensions`,buildReferenceSynthesisPresentation(historic,{},asins,fixed).moduleSections.length===5&&renderShape(historic).includes('类目商品链接调研 · 最终结论')); }
 const partial=structuredClone(report);partial.products[0].sales.last6Months=null;
 const part=buildReferenceSynthesisPresentation(partial,{},asins,fixed);
 check(s.name,'shape','partial-keeps-dimensions-no-total',part.moduleSections.length===5&&part.score===null&&renderShape(partial).includes(asins[0]));
 const empty={...report,products:[]};check(s.name,'shape','empty-keeps-final-placeholder',renderShape(empty).includes('类目商品链接调研 · 最终结论'));
 const altered=buildReferenceSynthesisPresentation(report,{[asins[0]]:s.forms[1]},asins.slice(1),fixed);
 check(s.name,'shape','manual-selection-recalculates-no-mutation',JSON.stringify(full)!==JSON.stringify(altered)&&before===JSON.stringify(report));
 check(s.name,'shape','same-frozen-input-replay',JSON.stringify(full)===JSON.stringify(buildReferenceSynthesisPresentation(JSON.parse(before),{},asins,fixed)));
 if(site!=='US')check(s.name,'shape','site-currency-not-usd-caption',!html.includes('10 美元价格带'));
 const facts=structuredClone(keywordRuleFixture().response.run.facts!);
 facts.scope={...facts.scope,marketplace:site,currency:marketSiteCurrency(site),nodeIdPath:node};
 const template=facts.members[0];facts.members=s.words.map((keyword,i)=>({...structuredClone(template),keyword,keywordId:`kw_${digest(keyword)}`,occurrences:template.occurrences.map(o=>({...o,seed:s.seed,sourceIndex:i,memberHash:digest(keyword)})),pageMetrics:{...structuredClone(template.pageMetrics),monthlySearchVolume:{value:10000-i*2000,reason:null}}}));
 facts.pool.uniqueObservedMemberCount=facts.members.length;facts.pool.maxMembers=100;facts.pool.omittedMemberIds=[];facts.pool.conflictingMemberIds=[];
 facts.semantics={status:'unavailable',unavailableKeywordIds:facts.members.map(m=>m.keywordId),unknownDimensionCount:0,unknownClusterCount:0,batches:[]};
 const {factsId:old,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const auto=buildKeywordOriginalEstimate({facts,productSeed:s.seed});
 const ahtml=renderToStaticMarkup(<MarketKeywordOriginalEstimateReport estimate={auto}/>);
 check(s.name,'keyword','default-complete-sections',ahtml.includes('五维综合结论')&&ahtml.includes('业务输出（14项）')&&ahtml.includes('产品开发方向'));
 const automatic=buildKeywordOriginalClassification(facts,s.seed);
 const revision=buildMarketKeywordRevision({facts,request:{...automatic.classification,factsId:facts.factsId,expectedParentRevisionId:null,note:'SYNTHETIC AUDIT'},authorId:randomUUID(),createdAt:'2026-09-01T00:00:00.000Z'});
 const manual=buildKeywordOriginalEstimate({facts,productSeed:s.seed,revision});
 const mhtml=renderToStaticMarkup(<MarketKeywordOriginalEstimateReport estimate={manual} manual/>);
 check(s.name,'keyword','manual-shows-complete-summary',mhtml.includes('五维综合结论')&&mhtml.includes('业务输出（14项）'),{payloadBusinessOutputs:manual.report.businessOutputs?.length});
 const missinghtml=renderToStaticMarkup(<MarketKeywordFactsReport facts={facts} semanticSkipped/>);
 check(s.name,'keyword','legacy-without-estimate-complete',missinghtml.includes('产品开发方向')&&!missinghtml.includes('综合结论尚未提供'));
 check(s.name,'keyword','historical-manual-input-replay',JSON.stringify(manual)===JSON.stringify(buildKeywordOriginalEstimate({facts:JSON.parse(JSON.stringify(facts)),productSeed:s.seed,revision:JSON.parse(JSON.stringify(revision))})));
 const semantics={w2:auto.report.dimensions.w2.rows,w3:auto.report.dimensions.w3.rows,w4:auto.report.dimensions.w4.rows};
 if(s.name==='Apple Slicers')check(s.name,'keyword','apple-not-app-control',!JSON.stringify(semantics.w4).includes('智能控制'),semantics.w4);
 if(s.name==='Storage Bins')check(s.name,'keyword','capacity-range-not-child-age',!JSON.stringify(semantics.w2).includes('儿童'),semantics.w2);
 if(site==='DE')check(s.name,'keyword','german-scenes-and-features-recognized',semantics.w3.length>0&&semantics.w4.length>0,semantics);
 const tasins=asins.slice(0,20),themeResults=tasins.map((asin,i)=>({asin,status:'success' as const,source:{sourceRecordId:`s-${ci}-${i}`,fetchedAt:'2026-09-01T00:00:00.000Z',sourceUpdatedAt:null},themes:[{sourceThemeId:`t-${ci}-${i}`,keyword:i===0?'First feature':'Second feature',content:`SYNTHETIC ${s.name} ${i===0?'first':'second'} summary`,mention:i===0?1000:10,positive:i===0?1000:10,negative:0}]}));
 const mappings=themeResults.map((r,i)=>({sourceThemeId:r.themes[0].sourceThemeId,groupId:i===0?'first':'second'}));
 const tf={aggregation:aggregateCustomerThemes({selectedAsins:tasins,results:themeResults,mappings}),labels:[],decisions:mappings.map(m=>({...m,status:'mapped' as const,reason:null,batchId:null}))};
 const baseline=deriveThemeSelection(tf,[],false,false,true,true),revised=deriveThemeSelection(tf,[tasins[0]],false,false,true,true);
 check(s.name,'theme','20-sample-summary-and-denominator',baseline.selectedAsins.length===20&&baseline.totals?.mention===1190&&baseline.evidence.length===2);
 check(s.name,'theme','manual-recalculates-frozen-facts',revised.selectedAsins.length===19&&revised.totals?.mention===190&&baseline.totals?.mention===1190);
 const thtml=renderToStaticMarkup(<MarketThemeTopicTable groups={revised.groups} entry={{report:{scope:{marketplace:site}}} as any} evidence={Object.fromEntries(revised.evidence.map(e=>[e.index,e]))} translations={{'group:0:label':{state:'ready',translated:'FIRST TRANSLATION'},'group:1:label':{state:'ready',translated:'SECOND TRANSLATION'}}}/>);
 check(s.name,'theme','revised-group-translation-correct',thtml.includes('SECOND TRANSLATION')&&!thtml.includes('FIRST TRANSLATION'));
 check(s.name,'theme','frozen-history-replay',JSON.stringify(baseline)===JSON.stringify(deriveThemeSelection(JSON.parse(JSON.stringify(tf)),[],false,false,true,true)));
 const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:site,currency:marketSiteCurrency(site),nodeIdPath:node,fromMonth:'2026-08',toMonth:'2026-08'};
 const source=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'market_ratings_count_distribution',requestIdentity:{nodeIdPath:node,marketplace:site,month:'2026-08'},responseIdentityPaths:{nodeIdPath:[['data','nodeIdPath']],month:[['data','month']],currency:[['data','currency']]},payload:{code:'OK',data:{nodeIdPath:node,month:'2026-08',marketplace:site,currency:scope.currency,items:[{label:'100-300',unitsRatio:.05,products:5,units:5},{label:'500-1000',unitsRatio:.8,products:80,units:80},{label:'1000以上',unitsRatio:.15,products:15,units:15}]}},fetchedAt:'2026-09-12T00:00:00.000Z',observationPeriod:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},units:{},coverage:{receivedCount:3,expectedCount:3,truncation:{status:'not-truncated'}}});
 const project=(nodeIdPath=node)=>projectMarketOverviewOriginalSynthesis({scope:{...scope,nodeIdPath},parameters:{headTopN:10,newProductMonths:6},sources:[source]});
 const overview=project();check(s.name,'overview','15-sections-partial-evidence',overview.chapters?.length===15&&overview.summary.score===null);
 check(s.name,'overview','review-threshold-correct',!overview.chapters?.find(c=>c.id==='rating-count')?.conclusion.includes('100.0%'));
 check(s.name,'overview','other-category-source-rejected',project(`${node}9`).sourceRefs.length===0);
 check(s.name,'overview','same-frozen-source-replay',JSON.stringify(overview)===JSON.stringify(project()));
 results.push({category:s.name,site,node,synthetic:true,shapeCount:150,keywordCount:s.words.length,themeSampleCount:20,semantics,shapeScore:full.score});
}
check('Mobility Scooters','shape','unrelated-scooter-not-kick-taxonomy',fixedShapeLabels('Mobility Scooters','990009999').length===0,fixedShapeLabels('Mobility Scooters','990009999'));
