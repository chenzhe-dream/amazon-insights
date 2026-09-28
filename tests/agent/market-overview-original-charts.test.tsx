import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketOverviewDistributions} from '../../app/market-overview-distributions';
import {normalizeMarketOverviewDistribution} from '../../server/domain/market-research/overview-distributions';
import type {MarketOverviewDistribution} from '../../shared/market-overview-distribution-contracts';
const render=(d:MarketOverviewDistribution)=>renderToStaticMarkup(<MarketOverviewDistributions embedded entries={[{month:'2026-08',operation:d.operation,status:'partial',sourceRef:null,fetchedAt:null,scopeBasis:'request-bound',distribution:d,issues:[]}]}/>);
test('seller chart displays source-normalized product shares rather than counts',()=>{
 const d=normalizeMarketOverviewDistribution('market_seller_type_concentration',{data:[{label:'FBA',asinNum:120,units:90},{label:'FBM',asinNum:30,units:10}]});
 const html=render(d);assert.match(html,/商品占比与销量占比/);assert.match(html,/商品占比 80%/);assert.doesNotMatch(html,/商品占比 120%/);
 d.rows[0].productsSharePct=null;assert.match(render(d),/商品占比 不可计算/);
});
test('A+ charts use separate complete sample and new-product denominators',()=>{
 const labels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
 const data=labels.flatMap((label,i)=>[{label,products:1,units:(i+1)*10},{label:`新品${label}`,products:1,units:5}]);
 const d=normalizeMarketOverviewDistribution('market_ebc_distribution',{data});const before=JSON.stringify(d),html=render(d);
 assert.equal((html.match(/class="overview-content-pie"/g)??[]).length,2);
 assert.match(html,/A\+视频销量占比/);assert.match(html,/新品A\+视频销量占比/);assert.match(html,/data-share="10"/);assert.match(html,/data-share="25"/);assert.equal(JSON.stringify(d),before);
 const missing=normalizeMarketOverviewDistribution('market_ebc_distribution',{data:data.filter(r=>r.label!=='新品无A+无视频')});
 const partial=render(missing);assert.match(partial,/销量占比分母未确认/);assert.equal((partial.match(/class="overview-content-pie"/g)??[]).length,1);
 const zero=normalizeMarketOverviewDistribution('market_ebc_distribution',{data:labels.map(label=>({label,products:0,units:0}))});
 assert.doesNotMatch(render(zero),/class="overview-content-pie"/);
});
