import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresAgentRepository} from '../../server/db/postgres-repository';
import {VisibilityConflictError,VisibilityPersonNotFoundError} from '../../server/db/module-visibility-repository';
import {ALL_MODULES} from '../../shared/module-visibility-contracts';
import {buildAgentApp} from '../../server/app';
import type {AuthenticationService} from '../../server/auth/authentication-service';

test('module visibility persists per DingTalk identity and production session; scopes edits and versions',async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);await runPostgresMigrations(pg.pool);
 const organizationId=randomUUID(),actorId=randomUUID(),userId=randomUUID(),otherId=randomUUID(),localId=randomUUID(),now=new Date().toISOString();
 for(const id of [actorId,userId,otherId,localId]){
  const org=id===otherId?randomUUID():organizationId;
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'同名人员','member','active',$4,$4)",[id,org,id+'@example.com',now]);
  if(id!==localId)await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk',$1,$2,$2,$3,$3)",[org,id,now]);
 }
 const repo=new PostgresAgentRepository(pg.pool),store=repo.moduleVisibility;
 assert.deepEqual(await store.read(organizationId,userId),ALL_MODULES);
 const list=await store.list(organizationId,'同名',1);assert.equal(list.total,2);
 await assert.rejects(store.save({organizationId,actorId,userId:otherId,visibleModules:[],version:0}),VisibilityPersonNotFoundError);
 await assert.rejects(store.save({organizationId,actorId,userId:localId,visibleModules:[],version:0}),VisibilityPersonNotFoundError);
 const first=await store.save({organizationId,actorId,userId,visibleModules:['voc','keywords'],version:0});
 assert.equal(first.version,1);assert.deepEqual(await store.read(organizationId,userId),['voc','keywords']);
 const concurrent=await Promise.allSettled([['voc'],[]].map(modules=>store.save({organizationId,actorId,userId,visibleModules:modules as ['voc'],version:1})));
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
 assert.ok(concurrent.some(r=>r.status==='rejected'&&r.reason instanceof VisibilityConflictError));
 await store.save({organizationId,actorId,userId,visibleModules:[],version:2});
 assert.deepEqual(await store.read(organizationId,userId),[]);
 const origin='http://127.0.0.1:31900',token='T'.repeat(43),proxy='visibility-fixture';
 let identity=userId,allowed=true;
 const users=(await pg.pool.query('SELECT * FROM users')).rows;
 const app=buildAgentApp({
  env:{NODE_ENV:'test',AGENT_SERVICE_PROXY_TOKEN:proxy,AGENT_SERVICE_TRUSTED_ORIGINS:origin},repository:repo,
  authService:{authenticate:async supplied=>supplied===token?{kind:'user',organizationId,userId:identity,sessionId:randomUUID(),role:'member',email:identity+'@example.com'}:null,
   findPublicUser:async id=>{const u=users.find(u=>u.id===id);return u?{id:u.id,organizationId:u.organization_id,email:u.email,displayName:u.display_name,role:u.role,status:u.status,createdAt:now,updatedAt:now}:null}
  } as AuthenticationService,
  authConfig:{mode:'authenticated',cookie:{name:'agent_session',secure:false,maxAgeSeconds:28800},sessionTtlMs:28800000,loginLimiter:{windowMs:900000,maxFailures:5,maxEntries:10000}},
  userPresenceAccess:{canView:async()=>allowed},
 });t.after(()=>app.close());
 const headers={origin,'x-agent-proxy-token':proxy,cookie:'agent_session='+token};
 const session=await app.inject({method:'GET',url:'/v1/auth/session',headers});
 assert.equal(session.statusCode,200,session.body);assert.deepEqual(session.json().visibleModules,[]);
 assert.equal(session.json().canManageModuleVisibility,true);
 identity=actorId;
 const response=await app.inject({method:'GET',url:'/v1/admin/module-visibility?q=',headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().total,2);
 const update=await app.inject({method:'PUT',url:'/v1/admin/module-visibility/'+userId,headers,payload:{visibleModules:['traffic'],version:3}});
 assert.equal(update.statusCode,200,update.body);
 allowed=false;
 assert.equal((await app.inject({method:'PUT',url:'/v1/admin/module-visibility/'+userId,headers,payload:{visibleModules:[],version:4}})).statusCode,403);
 assert.deepEqual(await store.read(organizationId,userId),['traffic']);
 assert.equal((await pg.pool.query("SELECT count(*)::int n FROM audit_events WHERE action='module-visibility.updated'")).rows[0].n,4);
 await pg.pool.query("UPDATE users SET role='admin' WHERE id=$1",[userId]);
 await pg.pool.query('INSERT INTO system_owners(user_id,organization_id) VALUES($1,$2)',[userId,organizationId]);
 assert.equal(await store.isOwner(organizationId,userId),true);
 assert.equal(await store.isOwner(randomUUID(),userId),false);
 assert.deepEqual(await store.read(organizationId,userId),ALL_MODULES);
 assert.equal((await store.list(organizationId,'',1)).people.find(p=>p.userId===userId)?.isSystemOwner,true);
 allowed=true;
 assert.equal((await app.inject({method:'PUT',url:'/v1/admin/module-visibility/'+userId,headers,payload:{visibleModules:[],version:4}})).statusCode,403);
 for(const sql of ["UPDATE users SET role='member' WHERE id=$1","UPDATE users SET status='disabled' WHERE id=$1","DELETE FROM users WHERE id=$1","DELETE FROM system_owners WHERE user_id=$1"]){
  await assert.rejects(pg.pool.query(sql,[userId]),/protected system owner/);
 }
 identity=userId;
 const ownerSession=await app.inject({method:'GET',url:'/v1/auth/session',headers});
 assert.equal(ownerSession.json().isSystemOwner,true);
 assert.deepEqual(ownerSession.json().visibleModules,ALL_MODULES);
});
