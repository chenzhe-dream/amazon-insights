import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresAgentRepository} from '../../server/db/postgres-repository';
import {buildAgentApp} from '../../server/app';
import type {AuthenticationService} from '../../server/auth/authentication-service';
import {ALL_MODULES,PersonalVisibilitySaveSchema,VisibilitySaveSchema} from '../../shared/module-visibility-contracts';

test('default configuration cannot carry grants and explicit grants require the statistics module',()=>{
 assert.equal(VisibilitySaveSchema.safeParse({visibleModules:ALL_MODULES,version:0,statisticsViewGranted:true}).success,false);
 assert.equal(PersonalVisibilitySaveSchema.safeParse({visibleModules:['voc'],version:0,statisticsViewGranted:true}).success,false);
 assert.equal(PersonalVisibilitySaveSchema.safeParse({visibleModules:ALL_MODULES,version:0}).success,true);
});

test('PostgreSQL and authenticated routes grant only organization statistics, preserve defaults, and revoke live',async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const org=randomUUID(),otherOrg=randomUUID(),manager=randomUUID(),member=randomUUID(),outsider=randomUUID(),now=new Date().toISOString();
 for(const [id,organization] of [[manager,org],[member,org],[outsider,otherOrg]]){
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,$1,'member','active',$4,$4)",[id,organization,id+'@example.test',now]);
  await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk',$1,$2,$2,$3,$3)",[organization,id,now]);
 }
 const repo=new PostgresAgentRepository(pg.pool),store=repo.moduleVisibility;
 const origin='http://127.0.0.1:31900',proxy='statistics-grant-test',token='T'.repeat(43);
 let identity=manager;
 const auth={authenticate:async supplied=>supplied===token?{kind:'user',userId:identity,organizationId:identity===outsider?otherOrg:org,role:'member',email:identity+'@example.test',sessionId:randomUUID()}:null,
 findPublicUser:async id=>{const u=(await pg.pool.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];return u?{id:u.id,organizationId:u.organization_id,email:u.email,displayName:u.display_name,role:u.role,status:u.status,createdAt:now,updatedAt:now}:null;}} as AuthenticationService;
 const app=buildAgentApp({env:{NODE_ENV:'test',AGENT_SERVICE_PROXY_TOKEN:proxy,AGENT_SERVICE_TRUSTED_ORIGINS:origin},repository:repo,authService:auth,
 authConfig:{mode:'authenticated',cookie:{name:'agent_session',secure:false,maxAgeSeconds:28800},sessionTtlMs:28800000,loginLimiter:{windowMs:900000,maxFailures:5,maxEntries:10000}},
 userPresenceAccess:{canView:async p=>p.kind==='user'&&p.userId===manager&&p.organizationId===org}});t.after(()=>app.close());
 const headers={origin,'x-agent-proxy-token':proxy,cookie:'agent_session='+token};
 const get=(url:string)=>app.inject({method:'GET',url,headers});
 const save=(version:number,grant?:boolean,modules=ALL_MODULES,userId=member)=>app.inject({method:'PUT',url:'/v1/admin/module-visibility/'+userId,headers,payload:{version,visibleModules:modules,...(grant===undefined?{}:{statisticsViewGranted:grant})}});
 assert.equal(await store.hasStatisticsViewGrant(org,member),false);
 assert.equal((await save(0)).statusCode,200); // historical full selection grants nothing
 identity=member;
 assert.equal((await get('/v1/auth/session')).json().canViewUserPresence,false);
 assert.equal((await get('/v1/admin/usage/people')).statusCode,403);
 assert.equal((await save(1,true)).statusCode,403); // cannot self-grant
 identity=manager;
 assert.equal((await save(1,true)).statusCode,200);
 assert.equal((await store.list(org,'',1)).people.find(p=>p.userId===member)?.statisticsViewGranted,true);
 assert.equal(await store.hasStatisticsViewGrant(otherOrg,member),false);
 assert.equal((await save(0,true,ALL_MODULES,outsider)).statusCode,404);
 identity=member;
 const session=(await get('/v1/auth/session')).json();
 assert.equal(session.canViewUserPresence,true);assert.equal(session.canManageModuleVisibility,false);assert.equal(session.user.role,'member');
 const people=await get('/v1/admin/usage/people');assert.equal(people.statusCode,200,people.body);assert.ok(!people.body.includes(outsider));
 const presence=await get('/v1/admin/users');assert.equal(presence.statusCode,200,presence.body);
 assert.equal((await get('/v1/admin/module-visibility')).statusCode,403);
 assert.equal((await app.inject({method:'PUT',url:'/v1/admin/module-visibility/defaults',headers,payload:{visibleModules:ALL_MODULES,version:0}})).statusCode,403);
 identity=manager;
 assert.equal((await save(1,false)).statusCode,409);assert.equal(await store.hasStatisticsViewGrant(org,member),true);
 assert.equal((await save(2)).statusCode,200);assert.equal(await store.hasStatisticsViewGrant(org,member),true); // old/bulk callers preserve
 assert.equal((await save(3,undefined,['voc'])).statusCode,200);assert.equal(await store.hasStatisticsViewGrant(org,member),false); // hidden module cannot read
 assert.equal((await save(4,true)).statusCode,200);
 assert.equal((await save(5,false)).statusCode,200);
 identity=member;
 assert.equal((await get('/v1/auth/session')).json().canViewUserPresence,false);
 assert.equal((await get('/v1/admin/usage/people')).statusCode,403);assert.equal((await get('/v1/admin/users')).statusCode,403);
 const events=await pg.pool.query("SELECT metadata_json FROM audit_events WHERE action='module-visibility.updated' AND target_id=$1 ORDER BY created_at",[member]);
 assert.equal(events.rows.length,6);assert.deepEqual(events.rows.at(-1).metadata_json.statisticsViewGrant,{before:true,after:false});
});
