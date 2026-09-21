import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresAgentRepository} from '../../server/db/postgres-repository';
import {VisibilityConflictError,VisibilityPersonNotFoundError} from '../../server/db/module-visibility-repository';
import {ALL_MODULES} from '../../shared/module-visibility-contracts';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {PostgresModuleVisibilityStore} from '../../server/db/postgres/module-visibility-store';
import {registerModuleVisibilityRoutes} from '../../server/routes/module-visibility';

test('defaults snapshot new DingTalk users, preserve local and returning users, isolate organizations and serialize versions',async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());
 await runPostgresMigrations(pg.pool);await runPostgresMigrations(pg.pool);
 const repo=new PostgresAgentRepository(pg.pool),store=repo.moduleVisibility,organizationId=randomUUID(),actorId=randomUUID(),now=new Date().toISOString();
 const initial=await repo.createInitialAdmin({id:actorId,organizationId,email:'admin@example.test',displayName:'Admin',passwordHash:'fixture-hash',createdAt:now});
 assert.ok(initial);
 const snapshot=async(id:string)=>(await pg.pool.query('SELECT * FROM user_module_visibility WHERE user_id=$1',[id])).rows[0];
 assert.equal(await snapshot(actorId),undefined);
 assert.deepEqual((await store.readDefaults(organizationId)).visibleModules,ALL_MODULES);
 const user=(org=organizationId)=>{const id=randomUUID();return {id,organizationId:org,email:id+'@example.test',displayName:'Fixture',role:'member' as const,status:'active' as const,createdAt:now,updatedAt:now}};
 const old=user();await repo.createUser(old);
 const first=await store.saveDefaults({organizationId,actorId,visibleModules:['voc'],version:0});assert.equal(first.version,1);
 assert.deepEqual(await store.read(organizationId,old.id),ALL_MODULES);
 const identity={id:randomUUID(),organizationId,corpId:'fixture-corp',subjectId:'fixture-subject',candidateEmail:'ding@example.test',fallbackEmail:'dingtalk+fixture@identity.invalid',displayName:'Ding',createdAt:now,auditEventId:randomUUID()};
 const ding=await repo.findOrCreateDingTalkUser!(identity);assert.equal(ding.created,true);
 assert.deepEqual(await store.read(organizationId,ding.user.id),['voc']);
 assert.equal((await store.list(organizationId,'Ding',1)).people.find(person=>person.userId===ding.user.id)!.configurationSource,'new-user-default');
 const local={...user(),passwordHash:'fixture-hash'};await repo.createLocalUser!(local);
 const ordinary=user();await repo.createUser(ordinary);
 for(const id of [local.id,ordinary.id])assert.deepEqual(await store.read(organizationId,id),ALL_MODULES);
 const concurrent=await Promise.allSettled([['keywords'] as const,[] as const].map(visibleModules=>store.saveDefaults({organizationId,actorId,visibleModules:[...visibleModules],version:1})));
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
 assert.ok(concurrent.some(r=>r.status==='rejected'&&r.reason instanceof VisibilityConflictError));
 await store.saveDefaults({organizationId,actorId,visibleModules:[],version:2});
 assert.equal((await repo.findOrCreateDingTalkUser!({...identity,id:randomUUID(),auditEventId:randomUUID()})).created,false);
 assert.equal((await repo.createLocalUser!({...local,id:randomUUID()})).created,false);
 assert.deepEqual(await store.read(organizationId,ding.user.id),['voc']);
 assert.deepEqual(await store.read(organizationId,local.id),ALL_MODULES);
 const newIdentity=()=>{const id=randomUUID();return {...identity,id,subjectId:id,candidateEmail:id+'@example.test',fallbackEmail:'dingtalk+'+id+'@identity.invalid',auditEventId:randomUUID()}};
 const empty=newIdentity();await repo.findOrCreateDingTalkUser!(empty);assert.deepEqual(await store.read(organizationId,empty.id),[]);
 assert.equal((await snapshot(empty.id)).default_version,3);
 await store.save({organizationId,actorId,userId:ding.user.id,visibleModules:['traffic'],version:1});
 assert.equal((await store.list(organizationId,'Ding',1)).people.find(person=>person.userId===ding.user.id)!.configurationSource,'personal');
 await store.saveDefaults({organizationId,actorId,visibleModules:['market'],version:3});
 assert.deepEqual(await store.read(organizationId,ding.user.id),['traffic']);
 const otherOrg=randomUUID(),other=user(otherOrg);await repo.createUser(other);
 assert.deepEqual(await store.read(otherOrg,other.id),ALL_MODULES);
 await assert.rejects(store.saveDefaults({organizationId:otherOrg,actorId,visibleModules:[],version:0}),VisibilityPersonNotFoundError);
 assert.equal((await store.readDefaults(otherOrg)).version,0);
 await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk','fixture-corp','owner',$1,$2,$2)",[actorId,now]);
 await pg.pool.query('INSERT INTO system_owners(user_id,organization_id) VALUES($1,$2)',[actorId,organizationId]);
 assert.deepEqual(await store.read(organizationId,actorId),ALL_MODULES);
 assert.equal((await pg.pool.query("SELECT count(*)::int n FROM audit_events WHERE action='module-visibility.defaults-updated'")).rows[0].n,4);
 // A snapshot failure must roll back account creation as well.
 await pg.pool.query("CREATE FUNCTION reject_fixture_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER reject_fixture_snapshot BEFORE INSERT ON user_module_visibility FOR EACH ROW EXECUTE FUNCTION reject_fixture_snapshot()");
 const rejected=newIdentity();await assert.rejects(repo.findOrCreateDingTalkUser!(rejected));assert.equal(await repo.findUserById(rejected.id),null);
 await pg.pool.query('DROP TRIGGER reject_fixture_snapshot ON user_module_visibility; DROP FUNCTION reject_fixture_snapshot()');
 // Route qualification, invalid input and conflicts, including static /defaults vs /:userId.
 const app=Fastify();t.after(()=>app.close());let allowed=true,authenticated=true;
 app.decorateRequest('authPrincipal',null);
 app.addHook('preHandler',async request=>{request.authPrincipal=authenticated?{kind:'user',userId:actorId,organizationId,role:'admin',email:initial.email,sessionId:randomUUID()}:null});
 app.setErrorHandler((e,_request,reply)=>reply.code((e as {statusCode?:number}).statusCode??500).send({error:String(e)}));
 registerModuleVisibilityRoutes(app,store,{canView:async()=>allowed});
 const path='/v1/admin/module-visibility/defaults';
 assert.equal((await app.inject({method:'GET',url:path})).json().version,4);
 assert.equal((await app.inject({method:'PUT',url:path,payload:{visibleModules:[],version:3}})).statusCode,409);
 assert.equal((await app.inject({method:'PUT',url:path,payload:{visibleModules:['unknown'],version:4}})).statusCode,400);
 assert.equal((await app.inject({method:'PUT',url:path,payload:{visibleModules:['voc','voc'],version:4}})).statusCode,400);
 assert.equal((await app.inject({method:'PUT',url:path,payload:{visibleModules:[],version:4}})).statusCode,200);
 allowed=false;
 for(const method of ['GET','PUT'] as const)assert.equal((await app.inject({method,url:path,...(method==='PUT'?{payload:{visibleModules:[],version:5}}:{})})).statusCode,403);
 authenticated=false;assert.equal((await app.inject({method:'GET',url:path})).statusCode,401);
 assert.equal((await store.readDefaults(organizationId)).version,5);
 // Hold a policy update transaction open: account creation must snapshot that
 // committed policy after release, rather than racing with a stale read.
 const transactionQueries=new PostgresQueryContext(pg.pool),transactionStore=new PostgresModuleVisibilityStore(transactionQueries);
 let release!:()=>void,ready!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve}),written=new Promise<void>(resolve=>{ready=resolve});
 const updating=transactionQueries.transaction(async()=>{await transactionStore.saveDefaults({organizationId,actorId,visibleModules:['keywords'],version:5});ready();await barrier});
 await written;
 const racing=newIdentity(),creating=repo.findOrCreateDingTalkUser!(racing);
 try{
  let waiting=false;
  for(let attempt=0;attempt<100;attempt++){
   const locks=await pg.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'");
   if(locks.rows.length){waiting=true;break}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(waiting,true,'account snapshot must wait for the pending default policy transaction');
 }finally{release();await Promise.all([updating,creating])}
 assert.deepEqual(await store.read(organizationId,racing.id),['keywords']);
 assert.equal((await snapshot(racing.id)).default_version,6);

});
