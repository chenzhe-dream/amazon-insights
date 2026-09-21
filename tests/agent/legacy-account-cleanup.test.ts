import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {cleanupLegacyAccounts} from '../../scripts/lib/cleanup-legacy-accounts.mjs';

test('custom account cleanup deletes only unreferenced accounts and archives referenced accounts without losing history',async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const organizationId=randomUUID(),now='2026-09-14T08:00:00.000Z';
 const ids=Array.from({length:5},()=>randomUUID());
 for(const [i,email] of ['ops-admin-2','ops-member-6','test-admin','ops-member-4','admin'].entries()){
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,$3,'member','active',$4,$4)",[ids[i],i===3?randomUUID():organizationId,email+'@amazon-insights.local',now]);
 }
 await pg.pool.query("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES($1,$2,'test', $3,$4)",[randomUUID(),ids[1],'2099-01-01',now]);
 await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk','fixture','bound',$1,$2,$2)",[ids[2],now]);
 const preview=await cleanupLegacyAccounts(pg.pool,{organizationId,apply:false});
 assert.equal(preview.filter(r=>r.action==='delete').length,1);assert.equal(preview.filter(r=>r.action==='archive').length,1);
 assert.equal((await pg.pool.query("SELECT count(*)::int n FROM users")).rows[0].n,5);
 const applied=await cleanupLegacyAccounts(pg.pool,{organizationId,apply:true});
 assert.deepEqual(applied,preview);
 assert.equal((await pg.pool.query("SELECT count(*)::int n FROM users")).rows[0].n,4);
 const archived=(await pg.pool.query('SELECT status,archived_at FROM users WHERE id=$1',[ids[1]])).rows[0];
 assert.equal(archived.status,'disabled');assert.ok(archived.archived_at);
 assert.ok((await pg.pool.query('SELECT revoked_at FROM sessions WHERE user_id=$1',[ids[1]])).rows[0].revoked_at);
 assert.equal((await cleanupLegacyAccounts(pg.pool,{organizationId,apply:true})).filter(r=>r.action!=='skip-bound').length,0);
});
