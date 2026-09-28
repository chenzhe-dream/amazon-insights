import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {projectMarketOverviewOriginalFields} from '../../server/domain/market-research/overview-original-fields';

const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'123:456',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
const parameters={headTopN:10 as const,newProductMonths:6 as const};
function source(operation:'market_research'|'market_research_statistics',values:Record<string,unknown>,month='2026-08',echoCurrency=true){
  const row={nodeIdPath:scope.nodeIdPath,month,marketplace:'US',currency:'USD',...values};
  const path=operation==='market_research'?['data','items',0]:['data'];
  return createMarketSourceEvidence({scope,provider:'sellerSprite',operation,requestIdentity:{nodeIdPath:scope.nodeIdPath,marketplace:'US',month},
    responseIdentityPaths:{nodeIdPath:[[...path,'nodeIdPath']],month:[[...path,'month']],...(echoCurrency?{currency:[[...path,'currency']]}:{})},
    payload:{code:'OK',data:operation==='market_research'?{items:[row]}:row},fetchedAt:'2026-09-12T00:00:00.000Z',
    observationPeriod:{kind:'calendar-months',fromMonth:month,toMonth:month},units:{},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}});
}
const project=(sources:ReturnType<typeof source>[],p:{headTopN:5|10|20;newProductMonths:1|3|6|12}=parameters)=>projectMarketOverviewOriginalFields({scope,parameters:p,sources});

test('original overview uses primary row, precise units, head divisor and field provenance',()=>{
  const main=source('market_research',{avgWeight:2.5,baseAvgWeight:1134,avgVolume:18,baseAvgVolume:295,avgBsr:0,avgProfit:12.4,top10ProductSales:1000,top10ProductRevenue:25000,top10ProductCrn:.4,l6NewRatio:.25,l6NewCount:0,l6NewAvgRevenue:100});
  const stats=source('market_research_statistics',{avgBsr:12,hlAvgPrice:30,hlAvgUnits:500,hlAvgRevenue:9000,firstShelfDate:'2020-01-03T00:00:00Z'});
  const result=project([main,stats]),f=result.fields;
  assert.equal(f.avgBsr.value,0);assert.equal(f.avgWeightLb.value,2.5);assert.equal(f.avgWeightG.value,1134);assert.equal(f.avgVolumeIn3.value,18);assert.equal(f.avgVolumeCm3.value,295);
  assert.equal(f.hlAvgUnits.value,100);assert.equal(f.hlAvgRevenue.value,2500);assert.equal(f.hlAvgPrice.value,30);assert.equal(f.productCrn.value,40);
  assert.equal(f.newRatio.value,25);assert.equal(f.newCount.value,0);assert.equal(f.firstShelfDate.value,'2020-01-03');
  assert.equal(f.hlAvgUnits.sourceField,'top10ProductSales');assert.match(f.hlAvgUnits.sourceRef!,/^market-source:[a-f0-9]{64}$/);
  assert.equal(f.hlAvgUnits.scopeBasis,'response-verified');
});

test('saved Top N and new window select only matching original fields',()=>{
  const main=source('market_research',{top5ProductSales:50,top10ProductSales:100,top20ProductSales:200,l1NewCount:1,l3NewCount:3,l6NewCount:6,l12NewCount:12});
  for(const [topN,months] of [[5,1],[10,3],[20,12]] as const){const f=project([main],{headTopN:topN,newProductMonths:months}).fields;
    assert.equal(f.hlAvgUnits.value,10);assert.equal(f.newCount.value,months);assert.equal(f.hlAvgUnits.sourceField,`top${topN}ProductSales`);}
});

test('missing, invalid, wrong month and missing currency echo never become zeros or money',()=>{
  const absent=project([]).fields;assert.equal(absent.avgBsr.value,null);assert.equal(absent.avgBsr.reason,'not-collected');
  const older=source('market_research',{avgBsr:8},'2026-07');assert.equal(project([older]).fields.avgBsr.value,null);
  const invalid=source('market_research',{avgBsr:'bad',l6NewCount:null,l6NewAvgPrice:22},'2026-08',false);
  const f=project([invalid]).fields;assert.equal(f.avgBsr.value,null);assert.equal(f.avgBsr.reason,'invalid-source');assert.equal(f.newCount.value,null);assert.equal(f.newCount.reason,'field-absent');assert.equal(f.newAvgPrice.value,null);assert.equal(f.newAvgPrice.reason,'unit-unknown');
  const stats=source('market_research_statistics',{newProductProportion:.3});assert.equal(project([stats]).fields.newRatio.value,.3);
});

test('non-finite numeric strings are rejected while original negative profit is retained',()=>{
  const main=source('market_research',{avgBsr:'9'.repeat(400),avgProfit:'-12.5',top10ProductSales:'9'.repeat(400),l6NewRatio:'9'.repeat(400)});
  const f=project([main]).fields;
  assert.equal(f.avgBsr.value,null);assert.equal(f.avgBsr.reason,'invalid-source');
  assert.equal(f.avgProfit.value,-12.5);assert.equal(f.hlAvgUnits.value,null);assert.equal(f.hlAvgUnits.reason,'invalid-source');
  assert.equal(f.newRatio.value,null);assert.equal(f.newRatio.reason,'invalid-source');
});

test('calendar rollover dates are rejected without suppressing dates outside report month',()=>{
  const main=source('market_research',{firstShelfDate:'2026-02-31T00:00:00Z',lastShelfDate:'2026-09-01T00:00:00Z'});
  const f=project([main]).fields;
  assert.equal(f.firstShelfDate.value,null);assert.equal(f.firstShelfDate.reason,'invalid-source');
  assert.equal(f.lastShelfDate.value,'2026-09-01');
});

test('unique node-id row and matching outer currency echo retain original values',()=>{
  const matched=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'market_research',requestIdentity:{nodeIdPath:scope.nodeIdPath,marketplace:'US',month:'2026-08'},
    responseIdentityPaths:{nodeId:[['data','items',0,'nodeId']],currency:[['currency']]},
    payload:{code:'OK',currency:'USD',data:{items:[{nodeId:'456',avgBsr:19,l6NewAvgPrice:22}]}},fetchedAt:'2026-09-12T00:00:00.000Z',
    observationPeriod:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},units:{},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}});
  const f=project([matched]).fields;
  assert.equal(f.avgBsr.value,19);assert.equal(f.newAvgPrice.value,22);assert.equal(f.newAvgPrice.scopeBasis,'request-bound');
  const duplicate=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'market_research',requestIdentity:{nodeIdPath:scope.nodeIdPath,marketplace:'US',month:'2026-08'},responseIdentityPaths:{},
    payload:{code:'OK',data:{items:[{nodeId:'456',avgBsr:19},{nodeId:'456',avgBsr:20}]}},fetchedAt:'2026-09-12T00:00:00.000Z',
    observationPeriod:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},units:{},coverage:{receivedCount:2,expectedCount:2,truncation:{status:'not-truncated'}}});
  assert.equal(project([duplicate]).fields.avgBsr.value,null);
});
