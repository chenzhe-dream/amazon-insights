import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublishedSellingSourceResolver } from '../../server/routes/selling-point-translations';
import type { RuntimeAgentRepository } from '../../server/db/repository';
import { exportSourceProjectFixture, exportVersionFixture } from './helpers/project-export-fixture';

function fixture() {
  const project = exportSourceProjectFixture();
  const version = { ...exportVersionFixture(), catalog: [{ asin: project.asins[0], listingBullets: ['Fresh report original'] }] };
  const repository = { findProjectById: async () => project, projectDisplayVersions: { readCurrent: async () => version } };
  return { project, version, resolve: createPublishedSellingSourceResolver(repository as unknown as RuntimeAgentRepository) };
}
test('selling source comes from authorized published report, not generated catalog or newer analysis run', async () => {
  const { project, version, resolve } = fixture();
  project.currentRunId = '77777777-7777-4777-8777-777777777777';
  const source = await resolve(project.organizationId, project.id, project.asins[0], version.versionId);
  assert.deepEqual(source.original, ['Fresh report original']);
  assert.equal(source.runId, version.runId);
  assert.equal(source.sourceComplete, true);
  assert.deepEqual((await resolve(project.organizationId, project.id, project.asins[1], version.versionId)).original, []);
});
test('selling source rejects foreign scope and version changes, but reads long originals without generating', async () => {
  const { project, version, resolve } = fixture();
  await assert.rejects(resolve('another-org', project.id, project.asins[0], version.versionId), /商品/);
  await assert.rejects(resolve(project.organizationId, project.id, 'B000000000', version.versionId), /商品/);
  await assert.rejects(resolve(project.organizationId, project.id, project.asins[0], '77777777-7777-4777-8777-777777777777'), /版本.*变化/);
  version.catalog[0].listingBullets = Array.from({ length: 12 }, () => 'x'.repeat(9000));
  assert.equal((await resolve(project.organizationId, project.id, project.asins[0], version.versionId)).original.length, 12);
  version.organizationId = 'another-org';
  await assert.rejects(resolve(project.organizationId, project.id, project.asins[0], version.versionId), /范围/);
});
