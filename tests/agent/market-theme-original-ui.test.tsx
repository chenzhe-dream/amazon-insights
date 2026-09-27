import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketThemeSampleTable,MarketThemeTopicTable,selectThemeSentiment,type Group} from '../../app/market-theme-result-view';
import {themeDetails,themeRuleEntry} from './helpers/market-theme-page-fixture';
import type {MarketThemeSampleMetadata} from '../../shared/market-theme-selection-contracts';
import {MarketThemeReport} from '../../app/market-theme-report';

test('original theme tabs use the saved planner and keep legacy overlap',()=>{
 const item=themeDetails(new URL('https://test.invalid/details?section=groups')).page.items[0] as Group;
 const groups=[{...item,index:0,totals:{mention:100,positive:80,negative:20,themeCount:1}},
 {...item,index:1,totals:{mention:100,positive:45,negative:40,themeCount:1}},
 {...item,index:2,totals:{mention:100,positive:0,negative:0,themeCount:1}}];
 assert.deepEqual(selectThemeSentiment(groups,'positive',true).map(g=>g.index),[0]);
 assert.deepEqual(selectThemeSentiment(groups,'negative',true).map(g=>g.index),[1,2]);
 assert.deepEqual(selectThemeSentiment(groups,'positive').map(g=>g.index),[0,1]);
 assert.deepEqual(selectThemeSentiment(groups,'negative').map(g=>g.index),[1,0]);
});

test('sample table renders saved https images with safe fallback for unsupported schemes',()=>{
 const asins=themeDetails(new URL('https://test.invalid/details?section=asins')).page.items.filter(i=>i.kind==='asin');
 const sample={asin:asins[0].asin,sourceOrder:1,title:{value:'Lamp'},sourceRank:{value:1},imageUrl:{value:'https://images.example.test/lamp.jpg'},customerSay:{value:null}} as MarketThemeSampleMetadata;
 const render=(value:string)=>renderToStaticMarkup(<MarketThemeSampleTable asins={asins} marketplace="US" samples={[{...sample,imageUrl:{...sample.imageUrl,value}}]}/>);
 assert.match(render(sample.imageUrl.value!),/<img[^>]+src="https:\/\/images.example.test\/lamp.jpg"/);
 assert.match(render(sample.imageUrl.value!),/referrerPolicy="no-referrer"/);
 assert.doesNotMatch(render('javascript:alert(1)'),/<img/);
});

test('new saved planner localizes labels without changing legacy source labels or inventing unknown text',()=>{
 const entry=themeRuleEntry();entry.report.versions.planner='market-theme-flow/rules-v3';
 const group=themeDetails(new URL('https://test.invalid/details?section=groups')).page.items[0] as Group;
 group.sourceLabel={text:'Brightness',totalLength:10,truncated:false};
 const current=renderToStaticMarkup(<MarketThemeTopicTable groups={[group]} entry={entry} evidence={{}}/>);
 assert.match(current,/亮度/);
 const old=renderToStaticMarkup(<MarketThemeTopicTable groups={[group]} entry={themeRuleEntry()} evidence={{}}/>);
 assert.doesNotMatch(old,/亮度/);assert.match(old,/Brightness/);
 group.sourceLabel={text:'Unlisted original theme',totalLength:23,truncated:false};
 assert.match(renderToStaticMarkup(<MarketThemeTopicTable groups={[group]} entry={entry} evidence={{}}/>),/Unlisted original theme/);
});

test('saved category name identifies the report while the node path remains available',()=>{
 const entry=themeRuleEntry();entry.report.categoryName='Floor Lamps';
 const html=renderToStaticMarkup(<MarketThemeReport entry={entry}/>);
 assert.match(html,/Floor Lamps/);assert.match(html,/228013:495224:3736561:1063294/);
});


test('sample failures distinguish invalid source data from connection failures in Chinese',()=>{
 const asin=themeDetails(new URL('https://test.invalid/details?section=asins')).page.items.find(i=>i.kind==='asin')!;
 for(const [reason,expected] of [['invalid-data','返回数据未通过校验'],['timeout','处理超时'],['upstream-temporary','上游暂时不可用']]){
  const html=renderToStaticMarkup(<MarketThemeSampleTable asins={[{...asin,status:'failed',reason}]} marketplace="US"/>);
  assert.ok(html.includes(expected));assert.ok(!html.includes(reason));
 }
});
