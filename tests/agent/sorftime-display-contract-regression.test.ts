import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalDataStageOutputResponseSchema } from '../../shared/agent-contracts';
import * as display from '../../server/db/postgres/project-display-version-store';

const asin = 'B000000001';
const base = { jobId: 'job', projectId: '10000000-0000-4000-8000-000000000001', runId: '10000000-0000-4000-8000-000000000002', jobVersion: 1, outputVersion: 1, contentHash: 'a'.repeat(64), updatedAt: '2026-10-12T00:00:00.000Z' };

test('product_content schema diagnostics survive strict stage output validation', () => {
  const result = LocalDataStageOutputResponseSchema.safeParse({ ...base, stage: 'listing', stageStatus: 'partial', data: { contentByAsin: {} },
    gap: { state: 'partial', reasonCode: 'MCP_SCHEMA', items: [{ asin, causeCode: 'MCP_SCHEMA', operation: 'product_content', boundary: 'consumer-shape' }] } });
  assert.equal(result.success, true);
});

function salesGaps(record: Record<string, unknown>, items: unknown[] = []) {
  const stages = ['keywords','reviews','sales_trend','fba','listing','category','traffic','child_sales','price_strategy','image_remarks'];
  const outputs = Object.fromEntries(stages.map(stage => [stage, { stage, stageStatus: 'missing-output', reasonCode: 'OUTPUT_UNAVAILABLE' }]));
  outputs.sales_trend = { ...base, stage: 'sales_trend', stageStatus: 'partial', data: { trendByAsin: { [asin]: record } }, gap: { state: 'partial', reasonCode: 'UPSTREAM_EMPTY', items } } as any;
  assert.equal(typeof (display as any).gapsFor, 'function');
  return (display as any).gapsFor([asin], [], outputs).filter((gap: any) => gap.field.startsWith('sales_trend'));
}

test('display projection retains explicit sales gaps even when evidence key exists', () => {
  assert.deepEqual(salesGaps({status: 'ready', volume: [{month:'2026-09',value:10}]}, [{asin,causeCode:'CONNECT_TIMEOUT'}]),
    [{asin,field:'sales_trend.trendByAsin',reasonCode:'CONNECT_TIMEOUT'}]);
});

test('daily and error sales evidence retain display gaps without changing ready records', () => {
  for (const record of [{status:'empty',volume:[],dailyObservations:{volume:[{date:'20261012',value:5}]}}, {status:'error',volume:[],observationErrors:{volume:'MCP_SCHEMA'}}]) {
    assert.deepEqual(salesGaps(record), [{asin,field:'sales_trend.trendByAsin',reasonCode:'UPSTREAM_EMPTY'}]);
  }
  assert.deepEqual(salesGaps({status:'ready',volume:[{month:'2026-09',value:10}]}), []);
  assert.deepEqual(salesGaps({volume:[{month:'2026-09',value:10}]}), []);
});
