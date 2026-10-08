import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketKeywordTable, keywordAnnualVolume, keywordSearchMatches} from '../../app/market-keyword-table';
import {MarketKeywordFactsSchema, type MarketKeywordFacts} from '../../shared/market-keyword-public-contracts';
import {keywordPageRun} from './helpers/market-keyword-page-fixture';
import {categoryMeta} from '../../app/keyword-meaning-taxonomy';
import type {MarketKeywordOriginalClassification} from '../../shared/market-keyword-original-contracts';

type Month=MarketKeywordFacts['members'][number]['trend']['months'][number];
function point(month:string,value:number|null):Month{
 const missing={value:null,reason:'missing' as const};
 const growth={value:null,reason:'missing-baseline' as const,baselineMonth:'2025-01',baselineValue:null,formulaVersion:'calendar-month-growth/v1' as const};
 return {month,searchVolume:{value,reason:value===null?'missing':null},searchRank:missing,recommendedBid:missing,yoyGrowth:growth,recentGrowth:growth};
}
function fixture(){const facts=keywordPageRun().run.facts!;facts.members=facts.members.slice(0,1);return facts;}

test('public transport accepts optional seasonality and historical months while preserving legacy facts',()=>{
 const facts=fixture(),before=JSON.stringify(facts);
 assert.deepEqual(MarketKeywordFactsSchema.parse(facts),facts);
 const extended=structuredClone(facts);
 Object.assign(extended.members[0].pageMetrics,{seasonality:'Peak season of search volume: 11月'});
 Object.assign(extended.members[0].trend,{historyMonths:[point('2025-01',40)]});
 assert.equal(MarketKeywordFactsSchema.safeParse(extended).success,true);
 assert.equal(JSON.stringify(facts),before);
});
test('table shows real seasonality, category explanation and Listing usage without changing frame',()=>{
 const facts=fixture();Object.assign(facts.members[0].pageMetrics,{seasonality:'Peak season of search volume: 11月'});
 const automaticClassification={meanings:[{keywordId:facts.members[0].keywordId,category:'core_product'}]} as MarketKeywordOriginalClassification;
 const html=renderToStaticMarkup(<MarketKeywordTable facts={facts} automaticClassification={automaticClassification} details={()=>null}/>);
 assert.match(html,/>11月</);
 assert.ok(html.includes(categoryMeta('core_product').description));assert.ok(html.includes(categoryMeta('core_product').listingHint));
 assert.match(html,/class="card launch-block"/);assert.match(html,/launch-table shape-price-table/);
 Object.assign(facts.members[0].pageMetrics,{seasonality:'--'});
 const missing=renderToStaticMarkup(<MarketKeywordTable facts={facts} details={()=>null}/>);
 assert.doesNotMatch(missing,/>均衡</);assert.doesNotMatch(missing,/>--</);
});
test('keyword table exposes reference-month and undated source-page search volumes separately',()=>{
 const facts=fixture(),member=facts.members[0];member.reference.searchVolume=321;member.pageMetrics.monthlySearchVolume.value=999;
 const html=renderToStaticMarkup(<MarketKeywordTable facts={facts} details={()=>null}/>);
 assert.match(html,/参考月搜索量/);assert.match(html,/来源页月搜索量/);assert.match(html,/>321</);assert.match(html,/>999</);
});
test('keyword search retains original substring, multi-token, and character-sequence matching',()=>{
 assert.equal(keywordSearchMatches('floor lamp for bedroom','lamp bedroom'),true);
 assert.equal(keywordSearchMatches('floor lamp for bedroom','flr lmp'),true);
 assert.equal(keywordSearchMatches('floor lamp for bedroom','desk lamp'),false);
});
test('history drives chart, complete annual totals, and clearly labelled partial known totals',()=>{
 const facts=fixture(),member=facts.members[0];member.trend.months=[point('2026-08',30)];
 const history=[...Array.from({length:12},(_,i)=>point(`2025-${String(i+1).padStart(2,'0')}`,10)),point('2026-07',20),point('2026-08',30)];
 Object.assign(member.trend,{historyMonths:history});
 assert.equal(keywordAnnualVolume(member,'2025'),120);
 const html=renderToStaticMarkup(<MarketKeywordTable facts={facts} details={()=>null}/>);
 assert.match(html,/2025 年搜索量/);assert.match(html,/>120</);assert.match(html,/>50</);
 assert.match(html,/已知合计[\s\S]*2\/12 月/);assert.match(html,/2025-01：10/);
 assert.match(html,/2026-07、2026-08/);
 assert.match(html,/2026-07：搜索量 20/);assert.match(html,/2026-08：搜索量 30/);
});
test('all missing year remains unknown, observed zero is retained, and old facts use months',()=>{
 const facts=fixture(),member=facts.members[0];member.trend.months=[point('2026-08',null)];
 const empty=renderToStaticMarkup(<MarketKeywordTable facts={facts} details={()=>null}/>);
 assert.doesNotMatch(empty,/已知合计/);
 member.trend.months=[point('2026-08',0)];
 const zero=renderToStaticMarkup(<MarketKeywordTable facts={facts} details={()=>null}/>);
 assert.match(zero,/已知合计[\s\S]*1\/12 月/);assert.match(zero,/>0</);
});
