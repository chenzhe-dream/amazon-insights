import assert from 'node:assert/strict';
import test from 'node:test';
import * as sales from '../../scripts/build-sorftime-sales-trend.mjs';
import {projectStageOutput} from '../../scripts/lib/sync-stage-output.mjs';
const asin = 'B0BWCQHCWX';
const wrap = (type, data) => ({data: {asin, type, data}});
test('product legacy rejects blank, invalid months and partial malformed payloads',()=>{
  const previous={status:'ready',fetchedAt:'2026-10-01',volume:[{month:'2026-09',value:100}]};
  for(const raw of ['2026年09月=','2026-09=   ','2026-13=12','2026年00月=12','2026-09=0,broken','prefix2026年09月=12']) {
    const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',previous,responses:{volume:raw}});
    assert.equal(record.observationOutcomes.volume.category,'malformed-response',raw);
    assert.deepEqual(record.volume,previous.volume); assert.equal(record.fieldFetchedAt.volume,'2026-10-01');
  }
  for(const raw of ['2026年09月=0','2026-09=0']) assert.deepEqual(sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',responses:{volume:raw}}).volume,[{month:'2026-09',value:0}]);
});
test('missing refresh preserves numeric evidence and missing dates with period provenance',()=>{
  const previous=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-01',responses:{volume:wrap('SalesVolume',[20260901,0,20260903,12])}});
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',previous,responses:{volume:wrap('SalesVolume',[20260901,-1,20260902,-1])}});
  assert.deepEqual(record.dailyObservations.volume,previous.dailyObservations.volume);
  assert.equal(record.dailyFieldFetchedAt.volume,'2026-10-01');
  assert.deepEqual(record.missingDailyObservations.volume,[{date:'2026-09-01',fetchedAt:'2026-10-12'},{date:'2026-09-02',fetchedAt:'2026-10-12'}]);
  assert.equal(record.observationOutcomes.volume.category,'daily-unverified');
  const monthly=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-13',previous:record,responses:{volume:wrap('SalesVolume',[202609,0,202610,-1])}});
  assert.deepEqual(monthly.missingDailyObservations.volume,record.missingDailyObservations.volume);
  assert.deepEqual(monthly.missingMonthlyObservations.volume,[{month:'2026-10',fetchedAt:'2026-10-13'}]);
});
test('sales projection retains daily evidence without claiming monthly readiness', () => {
  assert.equal(typeof sales.buildSalesTrendRecord, 'function');
  const record = sales.buildSalesTrendRecord({asin, marketplace:'US', fetchedAt:'2026-10-12', responses:{volume:wrap('SalesVolume',[20260901,123,20260902,124])}});
  assert.equal(record.status,'empty');
  assert.deepEqual(record.volume,[]);
  assert.deepEqual(record.dailyObservations.volume,[{date:'2026-09-01',value:123},{date:'2026-09-02',value:124}]);
  assert.match(record.statusMessage,/月度.*待确认/);
});
test('sales projection rejects metric mismatch but keeps valid independent observations', () => {
  assert.equal(typeof sales.buildSalesTrendRecord,'function');
  const record=sales.buildSalesTrendRecord({asin, marketplace:'US', fetchedAt:'2026-10-12',responses:{volume:wrap('SalesVolume',[202609,123]),price:wrap('SalesVolume',[202609,20])}});
  assert.equal(record.status,'error');
  assert.deepEqual(record.volume,[{month:'2026-09',value:123}]);
  assert.deepEqual(record.price,[]);
  assert.equal(record.observationErrors.price,'Invalid Sorftime trend identity or observation pairs');
});
test('a malformed refresh preserves previously validated monthly portions with their collection date',()=>{
  const previous={status:'ready',fetchedAt:'2026-10-01',volume:[{month:'2026-09',value:100}],price:[{month:'2026-09',value:20}]};
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',previous,
    responses:{volume:wrap('SalesVolume',[202609,123]),price:wrap('SalesVolume',[202609,20])}});
  assert.deepEqual(record.price,previous.price);
  assert.equal(record.fieldFetchedAt.price,'2026-10-01');
  assert.equal(record.fieldFetchedAt.volume,'2026-10-12');
});
test('partial immutable sales output retains daily evidence while recording an unready gap',()=>{
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',responses:{volume:wrap('SalesVolume',[20260901,123])}});
  const output=projectStageOutput('sales_trend',[asin],{stageStatus:'partial',dataAsins:[],readExport:()=>({[asin]:record})});
  assert.deepEqual(output.data.trendByAsin[asin]?.dailyObservations.volume,record.dailyObservations.volume);
  assert.deepEqual(output.gap.items.map(item=>item.asin),[asin]);
});
test('later transport failures retain successful earlier metrics and still collect remaining metrics',async()=>{
  assert.equal(typeof sales.collectSalesTrendResponses,'function');
  const types=[];
  const result=await sales.collectSalesTrendResponses({key:'fixture',asin,marketplace:'US',callTool:async(_key,_name,args)=>{
    types.push(args.type);
    if(args.type==='SalesAmount') throw new Error('offline timeout');
    return wrap(args.type,[202609,123]);
  }});
  assert.deepEqual(types,['SalesVolume','SalesAmount','Price','Rank']);
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',...result});
  assert.deepEqual(record.volume,[{month:'2026-09',value:123}]);
  assert.deepEqual(record.price,[{month:'2026-09',value:123}]);
  assert.equal(record.status,'error');
});

test('monthly refresh preserves daily source evidence and its collection date',()=>{
  const previous=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-01',responses:{volume:wrap('SalesVolume',[20260901,0,20260902,12])}});
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',previous,responses:{volume:wrap('SalesVolume',['202609',123])}});
  assert.deepEqual(record.dailyObservations.volume,previous.dailyObservations.volume);
  assert.equal(record.dailyFieldFetchedAt.volume,'2026-10-01');
  assert.deepEqual(record.volume,[{month:'2026-09',value:123}]);
});

test('strict string stamps reject coercions and invalid dates or values',()=>{
  for (const data of [[' 202609',1],['2.02609e5',1],['202613',1],['20260230',1],['202609','1'],['20260901',-2]]) {
    const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',responses:{volume:wrap('SalesVolume',data)}});
    assert.equal(record.observationOutcomes.volume.category,'malformed-response');
    assert.deepEqual(record.volume,[]);
  }
});

test('immutable partial output preserves closed valid-empty diagnostics without inventing points',()=>{
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',responses:{volume:wrap('SalesVolume',[])}});
  const output=projectStageOutput('sales_trend',[asin],{stageStatus:'partial',dataAsins:[],readExport:()=>({[asin]:record})});
  assert.equal(output.data.trendByAsin[asin].observationOutcomes.volume.category,'valid-empty');
  assert.deepEqual(output.data.trendByAsin[asin].volume,[]);
  assert.deepEqual(output.gap.items.map(item=>item.asin),[asin]);
});

test('legacy daily evidence retains original collection date on monthly refresh',()=>{
  const previous={asin,marketplace:'US',fetchedAt:'2026-10-01',status:'empty',volume:[],amount:[],price:[],rank:[],dailyObservations:{volume:[{date:'2026-09-01',value:10}]},fieldFetchedAt:{volume:'2026-09-30'}};
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',previous,responses:{volume:wrap('SalesVolume',['202609',123])}});
  assert.equal(record.dailyFieldFetchedAt.volume,'2026-09-30');
});

test('partial unknown refresh retains old numeric values and individual source collection dates',()=>{
 const previous=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-01',responses:{volume:wrap('SalesVolume',[20260901,0,20260903,12])}});
 const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',previous,responses:{volume:wrap('SalesVolume',[20260902,-1,20260904,5])}});
 assert.deepEqual(record.dailyObservations.volume,[{date:'2026-09-01',value:0},{date:'2026-09-03',value:12},{date:'2026-09-04',value:5}]);
 assert.deepEqual(record.dailyObservationFetchedAt.volume,{'2026-09-01':'2026-10-01','2026-09-03':'2026-10-01','2026-09-04':'2026-10-12'});
});

test('product parser separates missing stamps while generic/category numeric compatibility remains unchanged',async()=>{
 const {parseSorftimeProductTrend,parseSorftimeCategoryTrend,parseSorftimeTrend}=await import('../../scripts/lib/sorftime-trend-parse.mjs');
 const parsed=parseSorftimeProductTrend(wrap('SalesVolume',['20260901',0,'20260902',-1,'20260903',12]),{asin,type:'SalesVolume'});
 assert.deepEqual(parsed.daily,[{date:'2026-09-01',value:0},{date:'2026-09-03',value:12}]);assert.deepEqual(parsed.missingDaily,[{date:'2026-09-02'}]);
 assert.deepEqual(parseSorftimeCategoryTrend('2026-09='),[{month:'2026-09',value:0}]);
 assert.deepEqual(parseSorftimeTrend('2026-09='),[{month:'2026-09',value:0}]);
 const all=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',responses:{volume:wrap('SalesVolume',['202609',-1])}});
 assert.equal(all.status,'empty');assert.equal(all.observationOutcomes.volume.category,'source-unknown');assert.deepEqual(all.volume,[]);
});
