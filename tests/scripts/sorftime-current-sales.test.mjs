import assert from 'node:assert/strict';
import test from 'node:test';
import * as sales from '../../scripts/build-sorftime-sales-trend.mjs';
import {projectStageOutput} from '../../scripts/lib/sync-stage-output.mjs';
const asin = 'B0BWCQHCWX';
const wrap = (type, data) => ({data: {asin, type, data}});
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
