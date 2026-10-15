import test from 'node:test';
import assert from 'node:assert/strict';
import {readMarketShapeHistory,readMarketShapeAmountHistory} from '../../server/services/market-shape-history-reader';

for(const [kind,read] of [['collect-product-history',readMarketShapeHistory],['collect-product-amount-history',readMarketShapeAmountHistory]] as const){
 test(`${kind} bounds saved evidence reads for 150 products`,async()=>{
  const asins=Array.from({length:150},(_,i)=>`B${String(i).padStart(9,'0')}`);
  const steps=asins.map((asin,i)=>({stepKey:String(i),kind,status:'succeeded',latestAttemptId:String(i),input:{asin,selectionInputSnapshotId:'selection'}}));
  let calls=0;const releases:Array<()=>void>=[];
  const lookup=async()=>{calls++;await new Promise<void>(resolve=>releases.push(resolve));return undefined;};
  const input={asins,current:new Set(steps.map(s=>s.stepKey)),selectionInputSnapshotId:'selection',actor:{},
   view:{run:{id:'run',status:'succeeded',scope:{researchId:'study',marketplace:'US',currency:'USD',toMonth:'2026-09'}},steps,attempts:steps.map(s=>({id:s.latestAttemptId,status:'succeeded',output:{inputSnapshotId:'input',sourceRef:'source'}}))},
   snapshots:{findInput:lookup,findSource:lookup}} as unknown as Parameters<typeof read>[0];
  const pending=read(input);const rejected=assert.rejects(pending,/Historical (amount )?source differs/);
  try{assert.ok(calls>0);assert.ok(calls<=16,`started ${calls} database reads before any returned`);}
  finally{for(const release of releases)release();await rejected;}
 });
 test(`${kind} retains all products and their order`,async()=>{
  const asins=Array.from({length:150},(_,i)=>`B${String(i).padStart(9,'0')}`);
  const result=await read({asins,current:new Set(),selectionInputSnapshotId:'selection',actor:{},view:{run:{status:'queued',scope:{currency:'USD',toMonth:'2026-09'}},steps:[],attempts:[]},snapshots:{}} as unknown as Parameters<typeof read>[0]);
  assert.deepEqual(result.products.map(p=>p.asin),asins);
  assert.ok(result.products.every(p=>p.status==='queued'&&p.points.length===0));
 });
}
