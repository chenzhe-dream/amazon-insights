import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {MarketFavoriteCreateSchema} from '../../shared/market-favorites-contracts';
import {PostgresMarketFavoritesStore} from '../../server/db/postgres/market-favorites-store';
import {PostgresModuleVisibilityStore} from '../../server/db/postgres/module-visibility-store';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {registerMarketFavoritesRoutes} from '../../server/routes/market-favorites';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import type {RequestPrincipal} from '../../server/auth/authorization';

const input=()=>({id:randomUUID(),title:'共享市场报告',module:'keywords' as const,query:{marketNode:'123:456',marketMonth:'2026-08',marketFrom:'2026-01',marketHead:'10',marketNew:'6',marketSite:'US',keywordRun:randomUUID()},keywordInput:{seeds:'desk lamp\n台灯',categoryContext:'Lighting',pageCount:2,maxMembers:100}});

test('favorite request admits only restorable fields and bounded inputs',()=>{
 const valid=input();assert.equal(MarketFavoriteCreateSchema.safeParse(valid).success,true);
 for(const patch of [{organizationId:randomUUID()},{createdBy:randomUUID()},{title:''},{title:'a'.repeat(121)},{module:'admin'},{id:'bad'}])assert.equal(MarketFavoriteCreateSchema.safeParse({...valid,...patch}).success,false);
 for(const query of [{token:'secret'},{url:'https://example.com'},{marketNode:'https://example.com'},{marketMonth:'2026-13'},{marketHead:'99999999999'},{marketNew:'0'},{marketSite:'CN'},{keywordRun:'not-a-uuid'}])assert.equal(MarketFavoriteCreateSchema.safeParse({...valid,query}).success,false);
 for(const patch of [{seeds:'x'.repeat(20001)},{categoryContext:'x'.repeat(4001)},{pageCount:0},{pageCount:101},{maxMembers:2001},{token:'secret'}])assert.equal(MarketFavoriteCreateSchema.safeParse({...valid,keywordInput:{...valid.keywordInput,...patch}}).success,false);
});

test('shared favorites persist, isolate organizations, enforce deletion and idempotency through HTTP',async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);await runPostgresMigrations(pg.pool);
 const org=randomUUID(),otherOrg=randomUUID(),author=randomUUID(),colleague=randomUUID(),admin=randomUUID(),outsider=randomUUID(),now=new Date().toISOString();
 for(const id of [author,colleague,admin,outsider])await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',$6,$6)",[id,id===outsider?otherOrg:org,id+'@example.com',id===author?'原作者':'其他人员',id===admin?'admin':'member',now]);
 const queries=new PostgresQueryContext(pg.pool),store=new PostgresMarketFavoritesStore(queries),visibility=new PostgresModuleVisibilityStore(queries);
 let principal:RequestPrincipal|null=null;
 const login=(id:string)=>{principal={kind:'user',organizationId:id===outsider?otherOrg:org,userId:id,sessionId:randomUUID(),role:id===admin?'admin':'member',email:id+'@example.com'};};
 const app=Fastify();t.after(()=>app.close());app.decorateRequest('authPrincipal',null);app.addHook('preHandler',async request=>{request.authPrincipal=principal;});
 registerMarketFavoritesRoutes(app,store,visibility);
 const path='/v1/market-research/favorites',body=input();
 assert.equal((await app.inject({method:'GET',url:path})).statusCode,401);
 login(author);
 const created=await app.inject({method:'POST',url:path,payload:body});assert.equal(created.statusCode,200,created.body);assert.equal(created.json().favorite.createdBy,author);assert.equal(created.json().favorite.creatorName,'原作者');assert.equal(created.json().favorite.canDelete,true);
 const retries=await Promise.all(Array.from({length:3},()=>app.inject({method:'POST',url:path,payload:body})));for(const retry of retries){assert.equal(retry.statusCode,200,retry.body);assert.deepEqual(retry.json(),created.json());}
 assert.equal((await app.inject({method:'POST',url:path,payload:{...body,title:'覆盖尝试'}})).statusCode,409);
 login(colleague);
 const shared=await app.inject({method:'GET',url:path+'?q=共享&page=1&module=keywords'});assert.equal(shared.statusCode,200,shared.body);assert.equal(shared.json().total,1);assert.equal(shared.json().items[0].canDelete,false);assert.deepEqual(shared.json().items[0].keywordInput,body.keywordInput);
 assert.equal((await app.inject({method:'POST',url:path,payload:body})).statusCode,409);
 assert.equal((await app.inject({method:'DELETE',url:path+'/'+body.id})).statusCode,403);
 login(outsider);assert.equal((await app.inject({method:'GET',url:path})).json().total,0);assert.equal((await app.inject({method:'DELETE',url:path+'/'+body.id})).statusCode,404);assert.equal((await app.inject({method:'POST',url:path,payload:body})).statusCode,409);
 login(author);assert.equal((await app.inject({method:'DELETE',url:path+'/'+body.id})).statusCode,204);assert.equal((await app.inject({method:'GET',url:path})).json().total,0);
 const more=Array.from({length:12},(_,i)=>({...input(),title:'报告 '+i,module:'overview' as const}));
 for(const item of more)assert.equal((await app.inject({method:'POST',url:path,payload:item})).statusCode,200);
 const page=await app.inject({method:'GET',url:path+'?page=2'});assert.equal(page.json().items.length,2);assert.equal(page.json().total,12);assert.equal(page.json().pageSize,10);
 assert.equal((await app.inject({method:'GET',url:path+'?module=keywords'})).json().total,0);
 for(const query of ['?page=0','?page=1.5','?module=admin','?organizationId='+otherOrg])assert.equal((await app.inject({method:'GET',url:path+query})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:path,payload:{...input(),query:{token:'secret'}}})).statusCode,400);
 const concurrentInput=input();
 const concurrent=await Promise.all(Array.from({length:4},()=>app.inject({method:'POST',url:path,payload:concurrentInput})));
 for(const response of concurrent){assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),concurrent[0].json());}
 // A new store instance must see persisted data; no process-local favorite cache is involved.
 const reconnected=new PostgresMarketFavoritesStore(new PostgresQueryContext(pg.createPool()));
 assert.equal((await reconnected.list({organizationId:org,userId:colleague,role:'member'},{q:'',page:1})).total,13);
 await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk',$1,$2,$2,$3,$3)",[org,admin,now]);
 await pg.pool.query('INSERT INTO system_owners(user_id,organization_id) VALUES($1,$2)',[admin,org]);
 const ownerActor={organizationId:org,userId:admin,role:'member' as const};
 assert.equal((await reconnected.list(ownerActor,{q:'',page:1})).items[0].canDelete,true);
 await reconnected.delete(ownerActor,concurrentInput.id);
 login(admin);assert.equal((await app.inject({method:'GET',url:path})).json().items[0].canDelete,true);assert.equal((await app.inject({method:'DELETE',url:path+'/'+more[0].id})).statusCode,204);
 await pg.pool.query("INSERT INTO user_module_visibility(user_id,organization_id,modules_json,version,updated_by) VALUES($1,$2,'[]'::jsonb,1,$1)",[colleague,org]);
 login(colleague);for(const method of ['GET','POST','DELETE'] as const)assert.equal((await app.inject({method,url:method==='DELETE'?path+'/'+more[1].id:path,...(method==='POST'?{payload:input()}:{})})).statusCode,403);
 const unavailable=Fastify();t.after(()=>unavailable.close());unavailable.decorateRequest('authPrincipal',null);unavailable.addHook('preHandler',async request=>{request.authPrincipal=principal;});registerMarketFavoritesRoutes(unavailable,null);login(author);assert.equal((await unavailable.inject({method:'GET',url:path})).statusCode,503);
});
