import assert from 'node:assert/strict';
import test from 'node:test';
import {observation} from './helpers/market-shape-explanation-fixture';
import {readMarketProductMonth} from '../../server/domain/market-research/product-month-evidence';
import {buildMarketShapeSourceSummary} from '../../server/domain/market-research/shape-source-summary';
const read=async(month:string,patch?:(p:any)=>void)=>{const o=await observation(month,patch);return readMarketProductMonth(o,{[o.sourceRef]:o.source})};

test('collected source dashboard works before any manual revision and preserves real zero',async()=>{
 const anchor=await read('2026-08'),history=await read('2026-07');
 const summary=buildMarketShapeSourceSummary(anchor,[history],true);
 assert.equal(summary.totalUnits,220);assert.equal(summary.referenceRevenue,0);
 assert.deepEqual(summary.monthly.map(m=>m.totalUnits),[110,110]);
 assert.equal(summary.products[2].observations[0].units,0);
 assert.equal(summary.periods.find(p=>p.id==='last-3')!.products[0].units,null);
 assert.ok(summary.periods.find(p=>p.id==='last-3')!.issues.includes('period-not-collected'));
 assert.equal('revisionId' in summary,false);
});
test('missing historical month and unconfirmed legacy source stay unknown, not zero or a partial total',async()=>{
 const anchor=await read('2026-08',p=>{delete p.month;delete p.currency;delete p.marketplace;delete p.nodeIdPath});
 const summary=buildMarketShapeSourceSummary(anchor,[],true);
 assert.equal(summary.totalUnits,null);assert.equal(summary.monthly[0].totalUnits,null);
 assert.equal(summary.products[0].observations[1].units,100);
 assert.deepEqual(summary.products[0].observations[0].issues,['not-collected']);
 const legacy=buildMarketShapeSourceSummary(anchor,[],false);
 assert.equal(legacy.products[0].observations[1].units,null);assert.equal(legacy.referenceRevenue,null);
});
