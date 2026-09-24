import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketShapeCategoryDashboard} from '../../app/market-shape-category-dashboard';
import type {ShapeCategoryDashboard} from '../../shared/market-shape-category-contracts';
test('category dashboard labels live period, percentage bases and estimated amounts without replacing sample',()=>{
 const data:ShapeCategoryDashboard={provider:'sorftime',currency:'USD',referenceMonth:'2026-08',estimatedAmount:[{month:'2026-08',value:100}],sources:[{metric:'report',status:'ready',fetchedAt:'2026-09-24T00:00:00.000Z',sourceRef:'source',points:[],stats:{top100Units:200,top100Amount:300,top3ProductPct:17.52,top3BrandPct:null,top3SellerPct:null,amazonOwnedPct:0,averagePrice:2,medianPrice:1,returnRatePct:5.4}},{metric:'SalesCount',status:'ready',points:[{month:'2026-08',value:50}],stats:null,sourceRef:'source2',fetchedAt:'2026-09-24T00:00:00.000Z'}]};
 const html=renderToStaticMarkup(<MarketShapeCategoryDashboard data={data} node="1063294" marketplace="US" poolSize={10}/>);
 for(const text of ['近30天','17.52%','0%','估算销售额','销量占比','销售额占比','10','未知'])assert.ok(html.includes(text),text);
 const pending=renderToStaticMarkup(<MarketShapeCategoryDashboard data={{...data,sources:[],estimatedAmount:[]}} node="1063294" marketplace="US" poolSize={10}/>);
 assert.ok(pending.includes('等待类目历史'));assert.ok(!pending.includes('<svg'));
});
