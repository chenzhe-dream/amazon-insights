import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresMarketAnalysisSnapshotStore } from '../../server/db/postgres/market-analysis-snapshot-store';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import type { MarketAnalysisScope } from '../../shared/market-analysis-contracts';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { createMarketSourceEvidence } from '../../server/domain/market-research/source-evidence';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';

test('market research input storage isolates scope and preserves immutable evidence', {timeout:90_000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());
  await runPostgresMigrations(pg.pool);
  const store=new PostgresMarketAnalysisSnapshotStore(pg.pool);
  const actor={organizationId:randomUUID(),userId:randomUUID()};
  const outsider={organizationId:randomUUID(),userId:randomUUID()};
  const colleague={organizationId:actor.organizationId,userId:randomUUID()};
  const now='2026-09-12T08:00:00.000Z';
  for(const user of [actor,outsider,colleague])await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Snapshot test','member','active',$4,$4)",[user.userId,user.organizationId,`${user.userId}@example.com`,now]);
  const scope:MarketAnalysisScope={organizationId:actor.organizationId,researchId:randomUUID(),marketplace:'US',nodeIdPath:'228013:495224:3736561:1063294',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD'};
  const key=randomUUID();
  const request={actor,scope,idempotencyKey:key,now};
  const snapshotInput={scope,kind:'products',sourceVersion:'fixture/1',ruleVersion:'rules/1',collectedAt:'2026-09-12T07:00:00.000Z',expectedRecordIds:['B000000001'],records:[{id:'B000000001',scope,data:{units:0}}]};
  const sourceInput={scope,provider:'sellerSprite',operation:'market_product_concentration',requestIdentity:{marketplace:'US',month:'202608'},responseIdentityPaths:{month:[['month']]},payload:{month:'202608',data:[{asin:'B000000001',totalUnits:0}]},fetchedAt:'2026-09-12T07:00:00.000Z',observationPeriod:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},units:{units:{status:'known',unit:'count',rawUnit:'totalUnits'}},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}};

  await t.test('matching study creation is idempotent and key conflicts do not mutate the first scope',async()=>{
    const first=await store.createStudy(request);
    assert.equal(first.created,true);
    assert.equal((await store.createStudy(request)).created,false);
    await assert.rejects(()=>store.createStudy({...request,scope:{...scope,fromMonth:'2026-06'}}));
    assert.deepEqual((await store.findStudy({actor,id:scope.researchId}))?.scope,scope);
    assert.equal(await store.findStudy({actor:outsider,id:scope.researchId}),null);
    assert.equal((await store.findStudy({actor:colleague,id:scope.researchId}))?.id,scope.researchId);
  });
  await t.test('actor membership and research scope are checked again at the repository',async()=>{
    await assert.rejects(()=>store.createStudy({...request,actor:outsider}));
    await assert.rejects(()=>store.createStudy({...request,actor:{...actor,userId:outsider.userId}}));
    await assert.rejects(()=>store.saveInput({actor:outsider,studyId:scope.researchId,input:snapshotInput,now}));
    await assert.rejects(()=>store.saveInput({actor,studyId:scope.researchId,input:{...snapshotInput,scope:{...scope,toMonth:'2026-06'}},now}));
  });
  let inputId:string;
  await t.test('same snapshot saved concurrently is one immutable record and remains readable after restart',async()=>{
    const saved=await Promise.all([store.saveInput({actor,studyId:scope.researchId,input:snapshotInput,now}),store.saveInput({actor,studyId:scope.researchId,input:snapshotInput,now})]);
    inputId=saved[0].snapshot.snapshotId;
    assert.equal(saved[1].snapshot.snapshotId,inputId);
    assert.equal(saved.filter(item=>item.created).length,1);
    const restarted=new PostgresMarketAnalysisSnapshotStore(pg.pool);
    assert.deepEqual((await restarted.findInput({actor,studyId:scope.researchId,id:inputId}))?.snapshot,saved[0].snapshot);
    assert.equal(await restarted.findInput({actor:outsider,studyId:scope.researchId,id:inputId}),null);
    assert.equal(await restarted.findInput({actor,studyId:randomUUID(),id:inputId}),null);
  });
  await t.test('new source versions keep the previous input and accept observed zero values',async()=>{
    const next=await store.saveInput({actor,studyId:scope.researchId,input:{...snapshotInput,sourceVersion:'fixture/2',records:[{id:'B000000001',scope,data:{units:2}}]},now});
    assert.notEqual(next.snapshot.snapshotId,inputId);
    assert.equal((await store.findInput({actor,studyId:scope.researchId,id:inputId}))?.snapshot.records[0].data && ((await store.findInput({actor,studyId:scope.researchId,id:inputId}))!.snapshot.records[0].data as {units:number}).units,0);
  });
  let sourceId:string;
  await t.test('source identity and payload are validated before immutable source evidence is saved',async()=>{
    const saved=await store.saveSource({actor,studyId:scope.researchId,input:sourceInput,now});
    sourceId=saved.id;
    assert.equal(saved.evidence.responseIdentity.month.status,'verified');
    assert.equal((await store.saveSource({actor,studyId:scope.researchId,input:sourceInput,now})).created,false);
    assert.equal((await store.findSource({actor,studyId:scope.researchId,id:sourceId}))?.evidence.payloadHash,saved.evidence.payloadHash);
    assert.equal(await store.findSource({actor:outsider,studyId:scope.researchId,id:sourceId}),null);
    await assert.rejects(()=>store.saveSource({actor,studyId:scope.researchId,input:{...sourceInput,payload:{month:'202607'}},now}));
  });
  await t.test('database protects frozen studies, inputs and sources from overwrite or deletion',async()=>{
    await assert.rejects(pg.pool.query("UPDATE market_analysis_studies SET scope_json='{}' WHERE id=$1",[scope.researchId]));
    await assert.rejects(pg.pool.query("UPDATE market_analysis_inputs SET document_json='{}' WHERE id=$1",[inputId]));
    await assert.rejects(pg.pool.query('DELETE FROM market_analysis_inputs WHERE id=$1',[inputId]));
    await assert.rejects(pg.pool.query('DELETE FROM market_analysis_sources WHERE id=$1',[sourceId]));
  });
  await t.test('database and readers reject complete-scope drift even when organization and study IDs match',async()=>{
    const wrongScope={...scope,nodeIdPath:'999:888',fromMonth:'2026-06'};
    const forgedInput=createMarketInputSnapshot({...snapshotInput,scope:wrongScope,records:[{id:'B000000001',scope:wrongScope,data:{units:10}}]},new Date(now));
    const forgedSource=createMarketSourceEvidence({...sourceInput,scope:wrongScope},new Date(now));
    for(const [table,document,documentId] of [
      ['market_analysis_inputs',forgedInput,forgedInput.snapshotId],
      ['market_analysis_sources',forgedSource,`market-source:${canonicalJsonSha256(forgedSource)}`],
    ] as const) {
      const insert=()=>pg.pool.query(`INSERT INTO ${table}(id,organization_id,study_id,stored_by,stored_at,document_json,document_hash) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[documentId,actor.organizationId,scope.researchId,actor.userId,now,JSON.stringify(document),canonicalJsonSha256(document)]);
      await assert.rejects(insert,/scope/i);
      // Simulate an invalid legacy/imported record after bypassing the insertion
      // guard. The normal repository must still refuse to publish it.
      await pg.pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_scope`);
      try { await insert(); } finally { await pg.pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_scope`); }
      const read=table==='market_analysis_inputs'?await store.findInput({actor,studyId:scope.researchId,id:documentId}):await store.findSource({actor,studyId:scope.researchId,id:documentId});
      assert.equal(read,null);
    }
  });
  await t.test('inactive actors cannot read or write previously authorized studies',async()=>{
    await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[actor.userId]);
    assert.equal(await store.findStudy({actor,id:scope.researchId}),null);
    assert.equal(await store.findInput({actor,studyId:scope.researchId,id:inputId}),null);
    assert.equal(await store.findSource({actor,studyId:scope.researchId,id:sourceId}),null);
    await assert.rejects(()=>store.saveInput({actor,studyId:scope.researchId,input:snapshotInput,now}));
  });
});
