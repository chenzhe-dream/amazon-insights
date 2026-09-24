import assert from 'node:assert/strict';
import test from 'node:test';
import type { CurrentProjectDisplayVersion } from '../../app/lib/project-display-version-browser';
import { buildOverviewExportSection } from '../../app/project-export/overview-export-section';

const asin = 'B012345678';
function fixture(): CurrentProjectDisplayVersion {
  const stage = (name: string, data: unknown) => ({ stage: name, stageStatus: 'done', data });
  return {
    versionId: 'version', organizationId: 'org', projectId: 'project', runId: 'run', jobId: 'job',
    marketplace: 'US', asins: [asin], catalog: [{ asin, brand: 'Brand', title: '<Product>', price: null,
      sales: 9, rating: 4, reviews: 100, rank: null, subRank: 3, subRankCategory: 'Lamps',
      packageSize: '30 cm', packageWeight: '1 kg', specifications: ['Spec A', 'Spec B'],
      launch: '2025', format: 'Color / Size', variants: '7', synced: true, buyBoxSeller: 'Seller',
      fulfillment: 'FBA', listingBullets: ['Full original'], image: 'https://m.media-amazon.com/a.jpg' }],
    stageOutputs: {
      sales_trend: stage('sales_trend', { trendByAsin: { [asin]: { asin, marketplace: 'US', status: 'ready',
        volume: Array.from({ length: 30 }, (_, i) => ({ month: `${2024 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`, value: i })),
        amount: [{ month: '2024-01', value: 12 }], price: [{ month: '2024-01', value: 22 }], rank: [{ month: '2024-01', value: 555 }] },
        B099999999: { status: 'ready', volume: [{month:'secret',value:999}] } } }),
      child_sales: stage('child_sales', { rowsByAsin: { [asin]: Array.from({ length: 8 }, (_, i) => ({ asin: `child-${i}`, variant: `Color ${i}`, sales: i, observedAt: '2026-09-01' })) } }),
      price_strategy: stage('price_strategy', { strategyByAsin: { [asin]: { status: 'ready', currentPrice: 22, anchor: 'anchor', promotion: 'promotion', psychology: 'psychology', evidence: 'evidence' } } }),
      category: stage('category', { trendByNode: { node: { nodeId: 'node', asins: [asin], marketplace: 'US', status: 'ready', categoryName: 'Lamps',
        volume: [{month:'2026-01',value:100},{month:'2026-02',value:110}], amount: [{month:'2026-01',value:1000}],
        listingMonopoly: [{month:'2026-01',value:30}], brandMonopoly: [{month:'2026-02',value:40}], sellerMonopoly: [] } } }),
      fba: { stage: 'fba', stageStatus: 'missing-output', reasonCode: 'OUTPUT_UNAVAILABLE' },
    }, gaps: [{ asin, field: 'catalog.sellerSprite', reasonCode: 'UNVERIFIED' }],
    contentHash: 'hash', sourceCompletedAt: '2026-09-01', publishedAt: '2026-09-02',
  } as unknown as CurrentProjectDisplayVersion;
}

test('overview retains every trend and child row, nulls, strategy, specs, originals and scope', () => {
  const result = buildOverviewExportSection(fixture());
  assert.equal(result.status, 'ready');
  const text = JSON.stringify(result);
  for (const expected of ['Spec A', 'Spec B', 'Full original', 'anchor', 'promotion', 'psychology', 'evidence', 'UNVERIFIED', 'OUTPUT_UNAVAILABLE', 'Top100', 'Top3']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('secret'));
  const children = result.blocks.find(b => b.kind === 'table' && b.title.includes('披露子体'));
  assert.ok(children?.kind === 'table');
  assert.equal(children.rows.length, 8);
  const trend = result.blocks.find(b => b.kind === 'chart' && b.title.includes('月销量') && b.title.includes('竞品'));
  assert.ok(trend?.kind === 'chart');
  assert.equal(trend.labels.length, 30);
  const categoryAmount = result.blocks.find(b => b.kind === 'chart' && b.title.includes('类目月销售额'));
  assert.ok(categoryAmount?.kind === 'chart');
  assert.deepEqual(categoryAmount.series[0].values, [1000, null]);
  const matrix = result.blocks.find(b => b.kind === 'table' && b.title === '竞品参数总览');
  assert.ok(matrix?.kind === 'table');
  assert.equal(matrix.rows.find(r => r[0].text === '当前售价')?.[1].text, '$22');
});

test('overview preserves missing records without importing any global example data', () => {
  const version = fixture(); version.catalog = []; version.stageOutputs = {}; version.gaps = [];
  const result = buildOverviewExportSection(version);
  assert.equal(result.status, 'missing');
  assert.match(JSON.stringify(result), /暂无已生成结果/);
  assert.ok(!JSON.stringify(result).includes('Floor Lamps'));
});

test('overview rejects malformed or contradictory nested source fields', () => {
  const version = fixture();
  const stage = version.stageOutputs.sales_trend!;
  if ('data' in stage && stage.stage === 'sales_trend') (stage.data.trendByAsin[asin] as Record<string, unknown>).marketplace = 'UK';
  assert.throws(() => buildOverviewExportSection(version), /来源|范围/);
});

test('overview is a detached snapshot of all strings, rows and chart values', () => {
  const version = fixture(); const result = buildOverviewExportSection(version); const before = JSON.stringify(result);
  (version.catalog[0] as Record<string, unknown>).title = 'changed';
  version.catalog.length = 0;
  assert.equal(JSON.stringify(result), before);
});

test('overview preserves missing month values with every category node', () => {
  const version = fixture();
  const category = version.stageOutputs.category!;
  if ('data' in category && category.stage === 'category') {
    const node = category.data.trendByNode.node as Record<string, unknown>;
    node.volume = [{ month: '2026-01', value: 100 }, { month: '2026-02', value: null }];
    category.data.trendByNode.second = { ...node, nodeId: 'second', categoryName: 'Second category' };
  }
  const result = buildOverviewExportSection(version);
  assert.match(JSON.stringify(result), /Second category/);
  const metrics = result.blocks.find(block => block.kind === 'table' && block.title.includes('node') && block.title.includes('市场指标'));
  assert.ok(metrics?.kind === 'table');
  assert.equal(metrics.rows.find(row => row[0].text === '最近月销量')?.[1].text, '—');
});


test('overview links each ASIN to its marketplace and rejects malformed selected records', () => {
  const version = fixture();
  const matrix = buildOverviewExportSection(version).blocks.find(block => block.kind === 'table' && block.title === '竞品参数总览');
  assert.ok(matrix?.kind === 'table');
  assert.equal(matrix.rows.find(row => row[0].text === 'ASIN')?.[1].href, `https://www.amazon.com/dp/${asin}`);
  const stage = version.stageOutputs.sales_trend!;
  if ('data' in stage && stage.stage === 'sales_trend') stage.data.trendByAsin[asin] = 'invalid record';
  assert.throws(() => buildOverviewExportSection(version), /格式/);
});
