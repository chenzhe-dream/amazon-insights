import assert from 'node:assert/strict';
import test from 'node:test';
import {shapeStructureRevision} from './helpers/market-shape-page-fixture';
import {marketShapePublicRevision} from '../../server/services/market-shape-read-service';
import {sourceCatalog} from './helpers/market-shape-explanation-fixture';
import * as projection from '../../server/domain/market-research/shape-period-projection';
import {MarketShapeRevisionPublicSchema} from '../../shared/market-shape-public-contracts';

function fixture() {
 const base=shapeStructureRevision(), asins=['B000000001','B000000002','B000000003'];
 const months=['2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
 return {...base,scope:{...base.scope,fromMonth:months[0]},selectedAsins:asins,eligibleAsins:asins.slice(0,2),
  products:asins.map((asin,i)=>({...base.products[0],asin,shape:i===2?null:'shelf',observations:months.map((month,j)=>({month,rawUnits:i===0?j+1:0,units:i===2&&j===0?null:i===0?j+1:0,issues:i===2&&j===0?['member-missing']:[]}))})),
  groups:[base.groups[0],{...base.groups[0],labelId:null}],
  structure:{...base.structure!,products:asins.map((asin,i)=>({...base.structure!.products[0],asin,shape:i===2?null:'shelf',brand:{...base.structure!.products[0].brand,value:i===0?'A':'B'},listing:{...base.structure!.products[0].listing,value:i===0?'2025-01-01':null}}))}};
}
test('saved six-month evidence projects three/six months with a fixed comparable cohort and unknown-year groups',()=>{
 const report=fixture(),before=JSON.stringify(report),result=projection.buildMarketShapePeriodProjection(report);
 assert.equal(result.basisCatalogId,report.catalogId);
 const three=result.periods.find(p=>p.id==='last-3')!,six=result.periods.find(p=>p.id==='last-6')!,year=result.periods.find(p=>p.id==='year-2025')!;
 assert.equal(three.status,'available');assert.equal(three.segments[0].stats.units,15);assert.equal(six.segments[0].stats.units,21);
 assert.equal(three.segments[0].stats.monthlyUnitsPerLink,2.5);
 assert.deepEqual(three.segments[0].eligibleAsins,report.eligibleAsins);
 assert.equal(three.products[2].units,null);assert.deepEqual(three.products[2].issues,['outside-comparable-cohort']);
 assert.equal(three.segments[0].listingYears.find(r=>r.year===null)!.stats.units,0);
 assert.equal(three.segments[0].listingYears.find(r=>r.year===2025)!.stats.salesShare.denominator,15);
 assert.equal(year.status,'unavailable');assert.deepEqual(year.issues,['period-not-saved']);assert.equal(year.segments[0].stats.units,null);
 assert.equal(JSON.stringify(report),before);
});
test('zero observations, no eligible members, manual exclusions and partial-year windows do not manufacture statistics',()=>{
 const report=fixture();report.eligibleAsins=[];
 let result=projection.buildMarketShapePeriodProjection(report),three=result.periods.find(p=>p.id==='last-3')!;
 assert.equal(three.status,'unavailable');assert.deepEqual(three.issues,['no-comparable-members']);assert.equal(three.segments[0].stats.units,null);
 report.eligibleAsins=['B000000002'];report.selectedAsins=['B000000002'];report.products=report.products.filter(p=>p.asin==='B000000002');
 result=projection.buildMarketShapePeriodProjection(report);three=result.periods.find(p=>p.id==='last-3')!;
 assert.equal(three.segments[0].stats.units,0);assert.equal(three.segments[0].stats.salesShare.value,null);
 assert.deepEqual(three.products.map(p=>p.asin),['B000000002']);
});
test('public revision adds a separately versioned projection without changing saved catalog or original totals',async()=>{
 const catalog=await sourceCatalog(),before=JSON.stringify(catalog);
 const report=marketShapePublicRevision({ordinal:1,catalog,semanticStatus:'not-integrated'});
 assert.equal(report.periodProjection?.version,'market-shape-period-projection/v1');
 assert.equal(report.periodProjection?.basisCatalogId,catalog.catalogId);
 assert.equal(report.periodProjection?.periods.find(p=>p.id==='study')?.segments[0].stats.units,report.totalUnits);
 assert.equal(JSON.stringify(catalog),before);
});
test('invalid comparable identities and incomplete supposedly-comparable products fail closed',()=>{
 const report=fixture();report.eligibleAsins.push('B000000099');
 assert.throws(()=>projection.buildMarketShapePeriodProjection(report),/cohort|selected/i);
 report.eligibleAsins=['B000000003'];
 assert.throws(()=>projection.buildMarketShapePeriodProjection(report),/missing/i);
 report.eligibleAsins=['B000000001'];report.selectedAsins=['B000000002'];
 assert.throws(()=>projection.buildMarketShapePeriodProjection(report),/cohort|selected/i);
});
test('link shares count selected links while sales shares count only comparable units',()=>{
 const report=fixture(),period=projection.buildMarketShapePeriodProjection(report).periods.find(p=>p.id==='last-3')!;
 const a=period.segments[0].brands.find(b=>b.brand==='A')!,b=period.segments[0].brands.find(b=>b.brand==='B')!;
 assert.equal(a.stats.linkShare.value,1/3);assert.equal(a.stats.salesShare.value,1);
 assert.equal(b.stats.requestedLinks,2);assert.equal(b.stats.comparableLinks,1);assert.equal(b.stats.units,0);
});
test('earliest allowed study month keeps earlier display periods unavailable instead of failing the report',()=>{
 const report=fixture();report.scope.fromMonth='2000-01';report.scope.toMonth='2000-01';
 report.products=report.products.map(p=>({...p,observations:[{month:'2000-01',units:0,rawUnits:0,issues:[]}]}));
 const result=projection.buildMarketShapePeriodProjection(report);
 assert.equal(result.periods.find(p=>p.id==='year-1998')!.status,'unavailable');
 assert.equal(result.periods.find(p=>p.id==='last-6')!.fromMonth,'1999-08');
 assert.equal(result.periods.find(p=>p.id==='study')!.segments[0].stats.units,0);
});
test('complete saved calendar years use twelve months and public projections reject a foreign catalog',()=>{
 const report=fixture();report.scope.fromMonth='2025-01';
 report.products=report.products.map(p=>({...p,observations:Array.from({length:20},(_,i)=>({month:`${2025+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,units:1,rawUnits:1,issues:[]}))}));
 const result=projection.buildMarketShapePeriodProjection(report),year=result.periods.find(p=>p.id==='year-2025')!;
 assert.equal(year.monthCount,12);assert.equal(year.segments[0].stats.units,24);assert.equal(year.segments[0].stats.monthlyUnitsPerLink,1);
 assert.equal(MarketShapeRevisionPublicSchema.safeParse({...report,periodProjection:{...result,basisCatalogId:'market-shape-price:'+'0'.repeat(64)}}).success,false);
});
