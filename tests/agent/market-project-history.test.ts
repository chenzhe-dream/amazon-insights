import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {planProjectHistory, historyInsertSql, type HistoryRun} from '../../server/services/market-project-history';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';

const owner={organization_id:randomUUID(),created_by:randomUUID(),created_at:'2026-10-13T00:00:00.000Z'};
function run(moduleKind:string):HistoryRun{return {...owner,id:randomUUID(),request_json:{moduleKind,scope:{marketplace:'US',nodeIdPath:'1:1063294',fromMonth:'2026-08',toMonth:'2026-09'},params:{headTopN:10,newProductMonths:6}}};}
test('only explicit batch lineage combines reports; repeated runs remain separate and input scopes are authoritative',()=>{
 const runs=['overview','shape-price','keywords','customer-themes','overview'].map(run);
 const batch={...owner,id:randomUUID(),state_json:{categoryName:'Floor Lamps',modules:Object.fromEntries(['overview','shapes','keywords','themes'].map((m,i)=>[m,{runId:runs[i].id}]))}};
 const plan=planProjectHistory({runs,batches:[batch],legacy:[]});
 assert.equal(plan.items.length,2);assert.equal(plan.items[0].group,'历史联动调研');
 assert.equal(plan.items[0].context.overview?.nodeIdPath,'1:1063294');
 assert.equal(plan.items[1].context.overview?.runId,runs[4].id);
 assert.deepEqual(plan,planProjectHistory({runs:[...runs].reverse(),batches:[batch],legacy:[]}));
});
test('legacy conditions never acquire a guessed report and invalid records are recorded rather than imported',()=>{
 const old={...owner,id:randomUUID(),module:'overview',title:'旧收藏',query_json:{marketSite:'US',marketNode:'1063294',marketFrom:'2026-08',marketMonth:'2026-09'}};
 const plan=planProjectHistory({runs:[run('overview')],batches:[],legacy:[old,{...old,id:randomUUID(),query_json:{...old.query_json,marketMonth:'invalid'}}]});
 assert.equal(plan.items.length,2);assert.equal(plan.warnings.length,1);
 assert.equal(plan.items.find(p=>p.group==='旧版收藏')?.context.overview?.runId,undefined);
 assert.match(historyInsertSql(plan),/ON CONFLICT DO NOTHING/);assert.doesNotMatch(historyInsertSql(plan),/UPDATE |DELETE /);
});
test('a missing or foreign batch member cannot hide valid standalone tasks',()=>{
 const r=run('overview');const other=run('shape-price');other.organization_id=randomUUID();
 const plan=planProjectHistory({runs:[r,other],legacy:[],batches:[{...owner,id:randomUUID(),state_json:{modules:{overview:{runId:r.id},shapes:{runId:other.id}}}}]});
 assert.equal(plan.items.length,2);assert.equal(plan.warnings.length,1);assert.ok(plan.items.every(p=>p.group==='历史独立报告'));
});
test('transactional import is repeatable, preserves edits and rolls back on missing owner',async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,'history@example.com','Author','member','active',now(),now())",[owner.created_by,owner.organization_id]);
 const plan=planProjectHistory({runs:[run('overview')],batches:[],legacy:[]});
 await pg.pool.query(historyInsertSql(plan));
 await pg.pool.query("UPDATE market_project_favorites SET title='用户改名',note='保留备注',revision=2");
 await pg.pool.query(historyInsertSql(plan));
 const rows=(await pg.pool.query('SELECT title,note,revision FROM market_project_favorites')).rows;
 assert.deepEqual(rows,[{title:'用户改名',note:'保留备注',revision:2}]);
 const bad=planProjectHistory({runs:[run('overview'),{...run('keywords'),created_by:randomUUID()}],batches:[],legacy:[]});
 const client=await pg.pool.connect();try{await assert.rejects(client.query(historyInsertSql(bad)),/foreign key/);await client.query('ROLLBACK');}finally{client.release();}
 assert.equal((await pg.pool.query('SELECT count(*)::int n FROM market_project_favorites')).rows[0].n,1);
});
