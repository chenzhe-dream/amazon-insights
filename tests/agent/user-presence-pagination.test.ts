import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {PostgresAdminUserPresenceStore} from '../../server/db/postgres/admin-user-presence-store';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

test('presence pagination searches the whole organization, clamps pages, and excludes archived accounts', async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const organizationId = randomUUID(), asOf = '2026-09-14T08:00:00.000Z';
  for(let i=0;i<25;i++){
    const id = randomUUID(), label=String(i).padStart(2,'0');
    await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',$5,$5)",[id,i===24?randomUUID():organizationId,`person-${label}@example.com`,`人员 ${label}`,asOf]);
    if(i<23)await pg.pool.query("INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at) VALUES('dingtalk','fixture',$1,$2,$3,$3)",[id,id,asOf]);
  }
  const store = new PostgresAdminUserPresenceStore(new PostgresQueryContext(pg.pool));
  const query = {page:1,pageSize:10 as const,q:'',source:'dingtalk' as const,status:'all' as const};
  const first = await store.listOrganizationUsers({organizationId,asOf,query});
  assert.equal(first.users.length,10);
  assert.equal(first.pagination?.total,23);
  assert.equal(first.summary?.neverLoggedIn,23);
  const second = await store.listOrganizationUsers({organizationId,asOf,query:{...query,page:2}});
  assert.equal(second.users[0].displayName,'人员 10');
  assert.equal(new Set([...first.users,...second.users].map(u=>u.account)).size,20);
  const found = await store.listOrganizationUsers({organizationId,asOf,query:{...query,page:99,q:'人员 22'}});
  assert.equal(found.pagination?.page,1);assert.equal(found.users.length,1);
  assert.equal(found.users[0].displayName,'人员 22');
  const empty = await store.listOrganizationUsers({organizationId,asOf,query:{...query,q:'%'}});
  assert.equal(empty.pagination?.total,0);assert.equal(empty.users.length,0);
  const local = await store.listOrganizationUsers({organizationId,asOf,query:{...query,source:'local'}});
  assert.equal(local.pagination?.total,1);
  await pg.pool.query("UPDATE users SET archived_at=$1,status='disabled' WHERE email='person-23@example.com'",[asOf]);
  assert.equal((await store.listOrganizationUsers({organizationId,asOf,query:{...query,source:'all'}})).pagination?.total,23);
  assert.equal((await store.listOrganizationUsers({organizationId,asOf})).users.some(u=>u.account==='person-23@example.com'),false);
});
