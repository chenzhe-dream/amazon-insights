import assert from 'node:assert/strict';
import test from 'node:test';
import {marketNavigation,marketViewHref} from '../../app/lib/market-navigation';
test('market navigation includes favorites and retains current research while entering library',()=>{
 assert.equal(marketNavigation.some(item=>(item.view as string)==='favorites'),true);
 const href=marketViewHref('favorites' as never,new URLSearchParams('marketNode=1063294&overviewRun=fa3b0692-81ac-4771-ba53-4f43ce24de43'));
 assert.equal(new URL(href,'http://local').searchParams.get('themeView'),'favorites');
});

import {captureProjectContext,projectModuleHref} from '../../app/lib/market-project-favorites';
import {ProjectFavoriteCreateSchema} from '../../shared/market-project-favorites-contracts';
import {findHttpContract} from '../../shared/agent-contracts';
test('capture and restore retain independent scopes, remove collection triggers and preserve all report IDs',()=>{
 const params=new URLSearchParams('marketSite=US&marketNode=1:1063294&marketFrom=2026-06&marketMonth=2026-08&marketHead=10&marketNew=6&overviewRun=fa3b0692-81ac-4771-ba53-4f43ce24de43&marketShapeSite=DE&marketShapeNode=999&marketShapeFrom=2026-09&marketShapeMonth=2026-09&shapeRun=95cf0038-f904-4c70-9854-7f2c8112061a&linkedApply=1&syncJob=secret');
 const context=captureProjectContext(params,'2026-09');assert.equal(context.overview?.marketplace,'US');assert.equal(context.shapes?.marketplace,'DE');assert.equal(context.shapes?.nodeIdPath,'999');
 const restored=new URL(projectModuleHref(context,'shapes'),'http://localhost').searchParams;
 assert.equal(restored.get('shapeRun'),params.get('shapeRun'));assert.equal(restored.get('overviewRun'),params.get('overviewRun'));assert.equal(restored.get('marketShapeNode'),'999');assert.equal(restored.get('marketNode'),'1:1063294');
 for(const forbidden of ['linkedApply','linkedBatch','syncJob'])assert.equal(restored.has(forbidden),false);
 const conditions=new URL(projectModuleHref(context,'overview',true),'http://localhost').searchParams;assert.equal(conditions.has('overviewRun'),false);assert.equal(conditions.has('shapeRun'),false);
});
test('empty and unsafe contexts cannot be saved, and explicit blank module is not backfilled',()=>{
 assert.throws(()=>captureProjectContext(new URLSearchParams(),'2026-09'));
 const c=captureProjectContext(new URLSearchParams('marketNode=123&marketMonth=2026-08&marketShapeNode=&themeView=shapes'),'2026-09');assert.equal(c.shapes,undefined);
 assert.equal(ProjectFavoriteCreateSchema.safeParse({id:'fa3b0692-81ac-4771-ba53-4f43ce24de43',title:'X',context:{overview:{marketplace:'US',nodeIdPath:'https://evil',fromMonth:'2026-09',toMonth:'2026-08'}}}).success,false);
});
test('all project favorite proxy contracts are registered including static export route',()=>{
 for(const [method,path] of [['GET',''],['POST',''],['POST','/groups'],['GET','/export'],['GET','/fa3b0692-81ac-4771-ba53-4f43ce24de43'],['PATCH','/fa3b0692-81ac-4771-ba53-4f43ce24de43']] as const)assert.ok(findHttpContract(method,'/v1/market-research/project-favorites'+path));
 assert.equal(findHttpContract('GET','/v1/market-research/project-favorites/export')?.path,'/v1/market-research/project-favorites/export');
});

import Fastify from 'fastify';
import {registerMarketModuleRoutes} from '../../server/routes/market-modules';
test('shared favorite report authorization applies only to GET, never retry or other writes',async t=>{
 const app=Fastify();t.after(()=>app.close());app.decorateRequest('authPrincipal',null);const original='10000000-0000-4000-8000-000000000001',shared='20000000-0000-4000-8000-000000000002',id='30000000-0000-4000-8000-000000000003';
 app.addHook('preHandler',async req=>{req.authPrincipal={kind:'user',organizationId:original,userId:original,role:'member',email:'test@example.com',sessionId:original}});
 const calls:string[]=[];
 registerMarketModuleRoutes(app,{findRun:async(actor:{organizationId:string})=>{calls.push('read:'+actor.organizationId);return{}},retry:async(actor:{organizationId:string})=>{calls.push('write:'+actor.organizationId);return{moduleRunId:id,stepIds:[]}}} as never,async actor=>({...actor,organizationId:shared}));
 assert.equal((await app.inject({method:'GET',url:'/v1/market-analysis/runs/'+id})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/v1/market-analysis/runs/'+id+'/retry',payload:{}})).statusCode,200);
 assert.deepEqual(calls,['read:'+shared,'write:'+original]);
});
