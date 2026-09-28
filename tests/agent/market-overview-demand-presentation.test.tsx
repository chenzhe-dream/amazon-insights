import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketOverviewDemandTrend} from '../../app/market-overview-demand-trend';
const series=[{keyword:'floor lamp',status:'ready',points:[{month:'2026-04',value:100},{month:'2026-05',value:0},{month:'2026-07',value:80}],errorCode:null},{keyword:'standing lamp',status:'failed',points:[],errorCode:'timeout'}];
test('saved demand trend keeps observed zero, breaks absent months and retains per-keyword failures',()=>{
 const html=renderToStaticMarkup(<MarketOverviewDemandTrend demand={{status:'partial',seed:'Floor Lamps',referenceMonth:'2026-08',series,issues:[{operation:'aba_research_trend',code:'timeout',retryable:true}]}}/>);
 assert.equal((html.match(/data-search-month=/g)??[]).length,3);assert.equal((html.match(/<polyline/g)??[]).length,1);assert.match(html,/2026-05 0 次/);assert.doesNotMatch(html,/data-search-month="2026-06"/);assert.match(html,/standing lamp：请求超时/);assert.match(html,/不代表全类目总需求/);
});
test('legacy, failed, empty and single-month states are distinct and do not fabricate curves',()=>{
 const legacy=renderToStaticMarkup(<MarketOverviewDemandTrend/>);assert.match(legacy,/历史报告尚未采集/);assert.doesNotMatch(legacy,/<svg/);
 for(const status of ['failed','empty']){const html=renderToStaticMarkup(<MarketOverviewDemandTrend demand={{status,seed:null,referenceMonth:'2026-08',series:[],issues:[]}}/>);assert.doesNotMatch(html,/<svg/);assert.match(html,status==='failed'?/采集失败/:/未返回可用/);}
 const single=renderToStaticMarkup(<MarketOverviewDemandTrend demand={{status:'ready',seed:'Floor Lamps',referenceMonth:'2026-08',series:[{...series[0],points:[{month:'2026-08',value:0}]}],issues:[]}}/>);assert.match(single,/只有一个月/);assert.equal((single.match(/data-search-month=/g)??[]).length,1);assert.doesNotMatch(single,/<polyline/);
});
