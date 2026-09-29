import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSorftimeMarginObservation,resolveShapeMarginObservation} from '../../shared/market-shape-margin-observation';

const asin='B000000001';
const detail={asin,status:'ready' as const,imageUrl:null,sourceRef:'market-source:'+'a'.repeat(64),inputSnapshotId:'market-input:'+'b'.repeat(64),fetchedAt:'2026-09-28T00:00:00.000Z',errorCode:null,marginObservation:{grossProfitMargin:64.2,price:29.99}};
test('detail margin uses exact child identity and strict percent/price values, including a real zero',()=>{
 assert.deepEqual(parseSorftimeMarginObservation({data:{asin,gross_profit_rate:'64.2',price:'29.99'}},asin),detail.marginObservation);
 assert.deepEqual(parseSorftimeMarginObservation({data:{asin,gross_profit_rate:0,price:20}},asin),{grossProfitMargin:0,price:20});
 assert.deepEqual(parseSorftimeMarginObservation({data:{asin,gross_profit_rate:-2,price:20}},asin),{grossProfitMargin:-2,price:20});
 for(const bad of [null,'',true,'64.2%',101,Infinity])assert.equal(parseSorftimeMarginObservation({data:{asin,gross_profit_rate:bad,price:20}},asin),null);
 for(const bad of [null,'',true,0,-1])assert.equal(parseSorftimeMarginObservation({data:{asin,gross_profit_rate:64,price:bad}},asin),null);
 assert.equal(parseSorftimeMarginObservation({data:{asin:'B000000002',parent_asin:asin,gross_profit_rate:64,price:20}},asin),null);
 assert.equal(parseSorftimeMarginObservation({data:{gross_profit_rate:64,price:20}},asin),null);
});
test('same ASIN and price can fill only a missing margin; original zero wins',()=>{
 const p={asin,price:29.99,grossProfitMargin:null};
 assert.equal(resolveShapeMarginObservation(p,detail).value,64.2);
 assert.equal(resolveShapeMarginObservation(p,{...detail,status:'empty'}).value,64.2);
 assert.equal(resolveShapeMarginObservation({...p,grossProfitMargin:0},detail).value,0);
 assert.equal(resolveShapeMarginObservation({...p,grossProfitMargin:70},detail).value,70);
 assert.equal(resolveShapeMarginObservation(p,{...detail,asin:'B000000002'}).value,null);
 for(const status of ['queued','running','failed','cancelled'] as const)assert.equal(resolveShapeMarginObservation(p,{...detail,status}).value,null);
});
test('different prices are explained and never silently combined; legacy observations stay unavailable',()=>{
 const p={asin,price:39.99,grossProfitMargin:null};
 const conflict=resolveShapeMarginObservation(p,detail);assert.equal(conflict.value,null);assert.match(conflict.note,/售价.*不同/);
 assert.equal(resolveShapeMarginObservation({...p,price:null},detail).value,null);
 const {marginObservation:_removed,...legacy}=detail;
 assert.equal(resolveShapeMarginObservation(p,legacy).value,null);
 assert.equal(resolveShapeMarginObservation(p,undefined).value,null);
 assert.equal(resolveShapeMarginObservation({...p,price:29.99},{...detail,sourceRef:null}).value,null);
});
