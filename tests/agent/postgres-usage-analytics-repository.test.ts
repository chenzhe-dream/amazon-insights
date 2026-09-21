import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {startPostgresTestContainer} from "./helpers/postgres-test-container";
import {runPostgresMigrations} from "../../server/db/postgres/migrations";
import {PostgresQueryContext} from "../../server/db/postgres/query-context";
import {PostgresAgentRepository} from "../../server/db/postgres-repository";
import {buildAgentApp} from "../../server/app";
import type {AuthenticationService} from "../../server/auth/authentication-service";
test("usage PostgreSQL storage deduplicates, binds identities and isolates organizations",async t=>{
  const module=await import("../../server/db/postgres/usage-analytics-store").catch(()=>null);
  assert.ok(module,"usage PostgreSQL store must exist");
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());
  await runPostgresMigrations(pg.pool);await runPostgresMigrations(pg.pool);
  const now="2026-09-14T02:00:00.000Z";
  for(const [id,org] of [["u1","o1"],["u2","o2"]]){
    await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'同名人员','member','active',$4,$4)",[id,org,id+"@test.example",now]);
    await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk',$1,$2,$3,$4,$4)",[org,id,id,now]);
  }
  await pg.pool.query("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES('s1','u1',$1,$2,'2026-09-15T00:00:00Z')",["a".repeat(64),now]);
  const store=new module.PostgresUsageAnalyticsStore(new PostgresQueryContext(pg.pool));
  const scope={organizationId:"o1",userId:"u1",sessionId:"s1"};
  const event={eventId:randomUUID(),kind:"visit" as const,pageKey:"overview" as const,at:now};
  const batch={version:1 as const,tabId:randomUUID(),accountKey:JSON.stringify(["o1","u1"]),observedAt:now,events:[event]};
  await assert.rejects(()=>store.ingest(scope,{...batch,accountKey:JSON.stringify(["o2","u2"])},now));
  await store.ingest(scope,batch,now);await store.ingest(scope,batch,now);
  const token="T".repeat(43),origin="http://127.0.0.1:31900",proxy="usage-production-wiring-test";
  const app=buildAgentApp({
    env:{NODE_ENV:"test",AGENT_SERVICE_PROXY_TOKEN:proxy,AGENT_SERVICE_TRUSTED_ORIGINS:origin},
    repository:new PostgresAgentRepository(pg.pool),
    authService:{authenticate:async supplied=>supplied===token?{kind:"user",...scope,role:"member",email:"u1@test.example"}:null} as AuthenticationService,
    authConfig:{mode:"authenticated",cookie:{name:"agent_session",secure:false,maxAgeSeconds:28800},sessionTtlMs:28800000,loginLimiter:{windowMs:900000,maxFailures:5,maxEntries:10000}},
    userPresenceAccess:{canView:async()=>true},
  });
  t.after(()=>app.close());
  const headers={origin,"x-agent-proxy-token":proxy,cookie:"agent_session="+token};
  const wired=await app.inject({method:"POST",url:"/v1/auth/activity",headers,payload:{usage:batch}});
  assert.equal(wired.statusCode,200,wired.body);
  assert.equal(wired.json().usage.status,"recorded");
  assert.deepEqual(wired.json().usage.acknowledgedEventIds,[event.eventId]);
  const wiredReport=await app.inject({method:"GET",url:"/v1/admin/usage?period=day&date=2026-09-14",headers});
  assert.equal(wiredReport.statusCode,200,wiredReport.body);assert.equal(wiredReport.json().totals.visits,1);
  const report=await store.report("o1",{period:"day",date:"2026-09-14"},now);
  assert.equal(report.totals.visits,1);assert.equal(report.users[0].userId,"u1");
  assert.equal((await store.report("o2",{period:"day",date:"2026-09-14"},now)).totals.visits,0);
  assert.deepEqual((await store.searchPeople("o1","同名",20)).people.map(p=>p.userId),["u1"]);
  await assert.rejects(()=>store.ingest(scope,{...batch,events:[{...event,pageKey:"voc"}]},now));
  assert.equal((await store.report("o1",{period:"day",date:"2026-09-14"},now)).totals.visits,1);
  // A valid session without a DingTalk binding must never create person analytics.
  await pg.pool.query("DELETE FROM auth_identities WHERE user_id='u1'");
  assert.equal(await store.ingest(scope,{...batch,events:[{...event,eventId:randomUUID()}]},now),null);
  assert.equal(Number((await pg.pool.query("SELECT count(*) AS count FROM usage_events")).rows[0].count),1);
  await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk','o1','u1','u1',$1,$1)",[now]);
  await assert.rejects(()=>store.ingest(scope,{...batch,events:[{...event,eventId:randomUUID(),at:'2026-09-12T00:00:00Z'}]},now));
  // Delayed reporting uses observed activity, never the arrival time for presence.
  await store.ingest(scope,{...batch,observedAt:'2026-09-14T01:00:00Z',events:[]},'2026-09-14T03:00:00Z');
  assert.equal(new Date((await pg.pool.query("SELECT last_seen_at FROM sessions WHERE id='s1'")).rows[0].last_seen_at).toISOString(),now);
  await pg.pool.query("UPDATE sessions SET revoked_at=$1 WHERE id='s1'",[now]);
  await assert.rejects(()=>store.ingest(scope,batch,now));
});
