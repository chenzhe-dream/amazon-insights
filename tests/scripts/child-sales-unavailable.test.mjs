import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVariationRows, syncSorftimeChildSales } from '../../scripts/build-sorftime-child-sales.mjs';
import { childSalesOutcome, childSalesResultStatuses } from '../../scripts/lib/child-sales-outcomes.mjs';
import { readCachedDataExport } from '../../scripts/lib/sync-cache.mjs';

test('documented -1 child sales remain unknown upstream data rather than schema failure or zero', () => {
  const parsed = parseVariationRows({ data: [{ Asin: 'B09Q8MJP3R', SalesAmount: -1 }] });
  assert.deepEqual(parsed.rows, []);
  const outcome = childSalesOutcome(parsed);
  assert.equal(outcome.status, 'empty');
  assert.equal(outcome.verifiedEmpty, false);
  assert.equal(outcome.reasonCode, 'SALES_OBSERVATION_UNAVAILABLE');
  assert.equal(parsed.unavailableSalesRowCount, 1);
});

test('mixed malformed and stale rows retain schema failure, valid zero stays actual zero', () => {
  const invalid = parseVariationRows({ data: [{ Asin: 'B09Q8MJP3R', SalesAmount: -1 }, { Asin: 'B09VP9LJQX', SalesAmount: 'broken' }] });
  assert.equal(childSalesOutcome(invalid).status, 'schema-error');
  const zero = parseVariationRows({ data: [{ Asin: 'B09Q8MJP3R', SalesAmount: 0 }] });
  assert.equal(childSalesOutcome(zero).status, 'ready');
  assert.equal(zero.rows[0].sales, 0);
});

test('current job per-ASIN empty results survive an unrelated schema failure', () => {
  const base = { jobId: 'job', marketplace: 'DE' };
  const outcomes = {
    B09Q8MJP3R: { ...base, asin: 'B09Q8MJP3R', status: 'empty', reasonCode: 'SALES_OBSERVATION_UNAVAILABLE' },
    B09VP9LJQX: { ...base, asin: 'B09VP9LJQX', status: 'schema-error' },
    B07KSDSSS1: { ...base, jobId: 'old', asin: 'B07KSDSSS1', status: 'empty' },
    B09GY72DX2: { ...base, marketplace: 'CA', asin: 'B09GY72DX2', status: 'empty' },
  };
  assert.deepEqual(childSalesResultStatuses(outcomes, Object.keys(outcomes), base), {
    statuses: { B09Q8MJP3R: 'upstream-empty', B09VP9LJQX: 'connector-failed' },
    reasons: { B09Q8MJP3R: '上游近15日未采集到子体销量，销量未知', B09VP9LJQX: '上游子体销量字段格式无效' },
  });
});

test('offline builder persists per-ASIN unknowns and malformed gaps independently', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'child-sales-outcomes-'));
  const names = ['AGENT_SYNC_JOB_ID', 'SORFTIME_MARKETPLACE', 'SORFTIME_SCOPED_EVIDENCE_ONLY', 'REPAIR_INCOMPLETE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const priorExitCode = process.exitCode;
  try {
    process.env.AGENT_SYNC_JOB_ID = 'offline-outcome-test';
    process.env.SORFTIME_MARKETPLACE = 'DE';
    delete process.env.SORFTIME_SCOPED_EVIDENCE_ONLY;
    delete process.env.REPAIR_INCOMPLETE;
    process.exitCode = 0;
    const outputPath = path.join(fixture, 'children.ts');
    await syncSorftimeChildSales({ outputPath, asins: ['B09Q8MJP3R', 'B09VP9LJQX'], key: 'fixture-key',
      callTool: async (_key, _tool, args) => ({ data: [{ Asin: args.asin, SalesAmount: args.asin === 'B09Q8MJP3R' ? -1 : 'broken' }] }),
    });
    assert.equal(process.exitCode, 1, 'malformed sibling still fails its batch');
    const outcomes = readCachedDataExport(outputPath, 'sorftimeChildSalesOutcomeByAsin');
    assert.equal(outcomes.B09Q8MJP3R.status, 'empty');
    assert.equal(outcomes.B09Q8MJP3R.jobId, 'offline-outcome-test');
    assert.equal(outcomes.B09VP9LJQX.status, 'schema-error');
    const rows = readCachedDataExport(outputPath, 'sorftimeChildSales30d');
    assert.deepEqual(rows, { B09Q8MJP3R: [], B09VP9LJQX: [] });
  } finally {
    process.exitCode = priorExitCode;
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
