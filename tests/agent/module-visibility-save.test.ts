import assert from 'node:assert/strict';
import test from 'node:test';
import {saveModuleVisibility} from '../../app/lib/module-visibility-save';
import type {VisibilityPerson} from '../../shared/module-visibility-contracts';
const target:VisibilityPerson={userId:'11111111-1111-4111-8111-111111111111',displayName:'Test',account:'test@local.invalid',visibleModules:[],version:1,configured:true,statisticsViewGranted:false,isSystemOwner:false};
const input={visibleModules:['admin-users'] as const,version:1,statisticsViewGranted:true};
const updated={...target,visibleModules:['admin-users'],version:2,statisticsViewGranted:true};
test('successful response needs one write only',async()=>{
 let calls=0;const result=await saveModuleVisibility(target,input,async()=>{calls++;return Response.json({person:updated})});
 assert.equal(result.reconciled,false);assert.equal(calls,1);
});
for(const outcome of [504,502,'network'] as const)test('uncertain '+outcome+' uses a bounded read, never replays PUT',async()=>{
 const methods:string[]=[];const result=await saveModuleVisibility(target,input,async(path,init)=>{
  methods.push(init?.method??'GET');
  if(methods.length===1){if(outcome==='network')throw new TypeError('network');return new Response('',{status:outcome})}
  assert.ok(init?.signal);assert.equal(new URL(path,'http://local').searchParams.get('q'),target.account);
  return Response.json({people:[updated],page:1,pageSize:10,total:1});
 });assert.equal(result.reconciled,true);assert.deepEqual(methods,['PUT','GET']);
});
for(const person of [target,{...updated,statisticsViewGranted:false},{...updated,userId:'22222222-2222-4222-8222-222222222222'},{...updated,visibleModules:[]}])test('mismatched or unchanged state stays unconfirmed '+JSON.stringify(person),async()=>{
 let calls=0;await assert.rejects(saveModuleVisibility(target,input,async()=>++calls===1?new Response('',{status:504}):Response.json({people:[person],page:1,pageSize:10,total:1})),/尚未确认/);assert.equal(calls,2);
});
test('failed reconciliation reports unknown and clear denial does not reconcile',async()=>{
 let calls=0;await assert.rejects(saveModuleVisibility(target,input,async()=>{calls++;return new Response('',{status:504})}),/尚未确认/);assert.equal(calls,2);
 calls=0;await assert.rejects(saveModuleVisibility(target,input,async()=>{calls++;return new Response('',{status:403})}),/无权/);assert.equal(calls,1);
});
test('bulk display-only save does not assert or change a grant',async()=>{
 let calls=0;const result=await saveModuleVisibility(target,{visibleModules:['admin-users'],version:1},async()=>++calls===1?new Response('',{status:504}):Response.json({people:[updated],page:1,pageSize:10,total:1}));assert.equal(result.reconciled,true);
});
test('reconciliation stops waiting after five seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let calls=0,reading!:()=>void;const entered=new Promise<void>(resolve=>{reading=resolve});
 const pending=saveModuleVisibility(target,input,async(_path,init)=>{
  if(++calls===1)return new Response('',{status:504});
  return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')));reading();});
 });
 const check=assert.rejects(pending,/尚未确认/);await entered;t.mock.timers.tick(5_000);await check;assert.equal(calls,2);
});
