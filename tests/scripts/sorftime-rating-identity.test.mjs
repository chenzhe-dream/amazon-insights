import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { readCachedDataExport } from '../../scripts/lib/sync-cache.mjs';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const asin = 'B0BT9F1F72';
const metrics = { star_rating: 4.7, review_count: 183 };

for (const [name, raw, message] of [
  ['wrong ASIN', { data: { asin: 'B0CJV11YQF', ...metrics } }, /ASIN mismatch/],
  ['conflicting envelope ASIN', { asin: 'B0CJV11YQF', data: { asin, ...metrics } }, /ASIN mismatch/],
  ['top-level marketplace', { marketplace: 'CA', data: { asin, ...metrics } }, /marketplace mismatch/],
  ['top-level amz_site', { amz_site: 'CA', data: { asin, ...metrics } }, /marketplace mismatch/],
  ['nested marketplace', { data: { asin, marketplace: 'CA', ...metrics } }, /marketplace mismatch/],
  ['nested amz_site', { data: { asin, amz_site: 'CA', ...metrics } }, /marketplace mismatch/],
  ['document missing ASIN', { doc: {}, data: metrics }, /ASIN missing/],
  ['tool error', { isError: true, data: { asin, ...metrics } }, /schema invalid/],
  ['provider error', { error: 'provider failed', data: { asin, ...metrics } }, /schema invalid/],
]) {
  test(`direct rating acquisition rejects ${name} before relabeling requested identity`, async t => {
    const { records, calls } = await runRating(t, { raw });
    assert.equal(records[asin].status, 'error');
    assert.equal(records[asin].rating, null);
    assert.equal(records[asin].reviewCount, null);
    assert.match(records[asin].statusMessage, message);
    assert.equal(calls.length, 1);
  });
}

test('new direct rating acquisition retains public fixture values and same-job provenance with one call', async t => {
  const [raw] = JSON.parse(await readFile(path.join(root, 'tests/fixtures/sorftime/balance-board-product-details.json'), 'utf8'));
  const { records, calls } = await runRating(t, { raw });
  const record = records[asin];
  assert.deepEqual({ status: record.status, rating: record.rating, reviewCount: record.reviewCount },
    { status: 'ready', rating: 4.7, reviewCount: 183 });
  assert.equal(record.source, 'Sorftime');
  assert.deepEqual(record.provenance, {
    jobId: 'fixture-rating-job', asin, marketplace: 'US', fetchedAt: record.fetchedAt,
    connector: 'sorftime', stageId: 'rating', operation: 'product_detail', tool: 'product_detail',
  });
  assert.deepEqual(calls, [{ tool: 'product_detail', args: { asin, amz_site: 'US' } }]);
});

test('legacy provider detail without document or ASIN remains compatible', async t => {
  const { records, calls } = await runRating(t, { raw: metrics });
  assert.equal(records[asin].status, 'ready');
  assert.equal(records[asin].rating, 4.7);
  assert.equal(records[asin].reviewCount, 183);
  assert.equal(calls.length, 1);
});

test('healthy legacy ready cache retains original scope without provider call or invented provenance', async t => {
  const original = { asin, marketplace: 'US', fetchedAt: '2026-09-02', status: 'ready', rating: 4.7, reviewCount: 183 };
  const { records, calls } = await runRating(t, { raw: { isError: true }, existing: { [asin]: original } });
  assert.deepEqual(records[asin], original);
  assert.deepEqual(calls, []);
});

test('a previous-job scoped rating is acquired again and survives current-job partial review capture', async t => {
  const previous = { asin, marketplace: 'US', fetchedAt: '2026-09-02', status: 'ready', rating: 4.7, reviewCount: 183,
    source: 'Sorftime', provenance: { jobId: 'previous-job', asin, marketplace: 'US', fetchedAt: '2026-09-02',
      connector: 'sorftime', stageId: 'rating', operation: 'product_detail', tool: 'product_detail' } };
  const { records, calls } = await runRating(t, { raw: { data: { asin, star_rating: 4.8, review_count: 185 } }, existing: { [asin]: previous } });
  assert.equal(calls.length, 1);
  assert.equal(records[asin].rating, 4.8);
  assert.equal(records[asin].provenance.jobId, 'fixture-rating-job');
  const projected = projectStageOutput('reviews', [asin], { stageStatus: 'partial', readyAsins: [], jobId: 'fixture-rating-job', marketplace: 'US',
    readExport: (_file, name) => name === 'sorftimeRatingData' ? records : {} });
  assert.deepEqual(projected.data.ratingByAsin[asin], records[asin]);
  assert.deepEqual(projected.data.analysisByAsin, {});
});

test('a healthy current-job scoped rating remains reusable without another provider call', async t => {
  const record = { asin, marketplace: 'US', fetchedAt: '2026-09-02', status: 'ready', rating: 4.7, reviewCount: 183,
    source: 'Sorftime', provenance: { jobId: 'fixture-rating-job', asin, marketplace: 'US', fetchedAt: '2026-09-02',
      connector: 'sorftime', stageId: 'rating', operation: 'product_detail', tool: 'product_detail' } };
  const { records, calls } = await runRating(t, { raw: { isError: true }, existing: { [asin]: record } });
  assert.deepEqual(records[asin], record);
  assert.deepEqual(calls, []);
});

async function runRating(t, { raw, existing = {} }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sorftime-rating-identity-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
    return rm(resolved, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await mkdir(path.join(directory, 'app'), { recursive: true });
  await copyFile(path.join(root, 'scripts/build-sorftime-rating.mjs'), path.join(directory, 'scripts/build-sorftime-rating.mjs'));
  await writeFile(path.join(directory, 'app/competitor-data.ts'), `export const refreshedCatalog = ${JSON.stringify([{ asin, rating: 4.7, reviews: 183 }])};`);
  await writeFile(path.join(directory, 'app/sorftime-rating-data.ts'), `export const sorftimeRatingData = ${JSON.stringify(existing)};`);
  await writeFile(path.join(directory, 'response.json'), JSON.stringify(raw));
  await writeFile(path.join(directory, 'calls.jsonl'), '');
  await writeFile(path.join(directory, 'client.mjs'), `import fs from 'node:fs';
export function readSorftimeKey() { return 'local-fixture'; }
export async function callSorftimeTool(key, tool, args) {
  fs.appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify({ tool, args }) + '\\n');
  return JSON.parse(fs.readFileSync(new URL('./response.json', import.meta.url), 'utf8'));
}`);
  await writeFile(path.join(directory, 'loader.mjs'), `import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(root)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === './lib/sorftime-mcp-client.mjs') return { url: new URL('./client.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier.startsWith('./lib/')) return { url: pathToFileURL(path.join(root, 'scripts', specifier)).href, shortCircuit: true };
  return nextResolve(specifier, context);
}`);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory,
    NODE_ENV: 'test', SORFTIME_ASINS: asin, SORFTIME_MARKETPLACE: 'US', AGENT_SYNC_JOB_ID: 'fixture-rating-job', FORCE_REFRESH: '0', REFRESH_STALE_DAYS: '0' };
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-loader', pathToFileURL(path.join(directory, 'loader.mjs')).href, path.join(directory, 'scripts/build-sorftime-rating.mjs')],
      { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(output.code, 0, output.stderr + output.stdout);
  const calls = (await readFile(path.join(directory, 'calls.jsonl'), 'utf8')).trim();
  return { records: readCachedDataExport(path.join(directory, 'app/sorftime-rating-data.ts'), 'sorftimeRatingData'),
    calls: calls ? calls.split('\n').map(line => JSON.parse(line)) : [] };
}
