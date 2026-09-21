import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSqliteAgentRepository } from '../../server/db/sqlite-repository';
import { PostgresAgentRepository } from '../../server/db/postgres-repository';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

for (const backend of ['SQLite', 'PostgreSQL']) test(`${backend}: VOC automation intents persist, isolate tenants, validate and roll back`, async (t) => {
  let repository: ReturnType<typeof openSqliteAgentRepository> | PostgresAgentRepository;
  let reopen!: () => Promise<typeof repository>;
  if (backend === 'SQLite') {
    const directory = mkdtempSync(join(tmpdir(), 'voc-automation-'));
    repository = openSqliteAgentRepository({ path: join(directory, 'agent.sqlite'), busyTimeoutMs: 5_000 });
    reopen = async () => openSqliteAgentRepository({ path: join(directory, 'agent.sqlite'), busyTimeoutMs: 5_000 });
    t.after(async () => { await repository.close(); rmSync(directory, { recursive: true, force: true }); });
  } else {
    const postgres = await startPostgresTestContainer();
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    await postgres.pool.query(`CREATE SCHEMA ${schema}`);
    const pool = postgres.createPool({ searchPath: schema });
    await runPostgresMigrations(pool);
    repository = new PostgresAgentRepository(pool);
    reopen = async () => new PostgresAgentRepository(postgres.createPool({ searchPath: schema }));
    t.after(async () => { await repository.close(); await postgres.close(); });
  }
  const organizationId = randomUUID(), projectId = randomUUID(), actorId = randomUUID(), baseSyncRunId = randomUUID();
  const updatedAt = '2026-09-11T00:00:00.000Z';
  await repository.createUser({ id: actorId, organizationId, email: `${actorId}@test.com`, displayName: 'Test', role: 'admin', status: 'active', createdAt: updatedAt, updatedAt });
  await repository.createProject({ id: projectId, organizationId, name: 'Test', marketplace: 'US', asins: ['B0ABC12345', 'B0DEF67890', 'B0GHI13579'], createdBy: actorId, createdAt: updatedAt, updatedAt });
  await repository.createAnalysisRun({ id: baseSyncRunId, projectId, mode: 'existing-data', status: 'queued', createdBy: actorId, dataCutoffAt: updatedAt, idempotencyScope: projectId, idempotencyKey: 'base', createdAt: updatedAt, updatedAt });
  assert.ok(repository.vocAutomations, 'repository exposes durable automation intent storage');
  const record = { organizationId, projectId, actorId, baseSyncRunId, selectedAsins: ['B0ABC12345'], retryKey: null, fingerprint: null, runId: null, updatedAt };
  assert.equal(await repository.vocAutomations.get(organizationId, projectId), null);
  await repository.transaction(async () => { await repository.vocAutomations.lock(organizationId, projectId); await repository.vocAutomations.save(record); });
  assert.deepEqual(await repository.vocAutomations.get(organizationId, projectId), record);
  assert.equal(await repository.vocAutomations.get(randomUUID(), projectId), null);
  const replacement = { ...record, selectedAsins: ['B0ABC12345', 'B0DEF67890'], retryKey: 'retry-1', fingerprint: 'a'.repeat(64), runId: baseSyncRunId };
  await repository.vocAutomations.save(replacement);
  assert.deepEqual(await repository.vocAutomations.list(), [replacement]);
  await repository.close();
  repository = await reopen();
  assert.deepEqual(await repository.vocAutomations.get(organizationId, projectId), replacement, 'intent survives repository restart');
  await assert.rejects(repository.transaction(async () => { await repository.vocAutomations.save(record); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(await repository.vocAutomations.get(organizationId, projectId), replacement);
  for (const invalid of [ { ...record, selectedAsins: ['bad'] }, { ...record, selectedAsins: ['B0DEF67890', 'B0ABC12345'] }, { ...record, selectedAsins: ['B0ABC12345', 'B0ABC12345'] }, { ...record, selectedAsins: [] }, { ...record, organizationId: randomUUID() }, { ...record, actorId: randomUUID() }, { ...record, baseSyncRunId: randomUUID() }, { ...record, runId: randomUUID() } ]) {
    await assert.rejects(repository.vocAutomations.save(invalid));
  }
  await assert.rejects(repository.transaction(() => repository.vocAutomations.lock(randomUUID(), projectId)));
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const first = repository.transaction(async () => {
    await repository.vocAutomations.lock(organizationId, projectId);
    locked();
    await gate;
    await repository.vocAutomations.save(record);
  });
  await acquired;
  let secondEntered = false;
  const second = repository.transaction(async () => {
    await repository.vocAutomations.lock(organizationId, projectId);
    secondEntered = true;
    assert.deepEqual(await repository.vocAutomations.get(organizationId, projectId), record);
    await repository.vocAutomations.save(replacement);
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(secondEntered, false, 'project intent lock lasts until the outer transaction commits');
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(await repository.vocAutomations.list(), [replacement]);
});
