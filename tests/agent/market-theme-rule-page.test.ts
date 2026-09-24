import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { aggregateCustomerThemes } from '../../server/domain/market-research/customer-themes';
import { deriveThemeSelection, projectThemeSample } from '../../server/domain/market-research/customer-theme-selection';
import { MarketThemeSelectionResponseSchema } from '../../shared/market-theme-selection-contracts';
import { themeDetails, themeEvidence, themeRuleEntry, themeRuleRun, themeRunId } from './helpers/market-theme-page-fixture';

test('rules-only theme page shows saved source themes and evidence without a model-pending state', { timeout: 120_000 }, async t => {
  const entry = themeRuleEntry(), asins = entry.report.selectedAsins;
  const results = asins.map((asin, index) => ({
    asin, status: 'success' as const,
    source: { sourceRecordId: `source-${index}`, fetchedAt: entry.report.dataCutoffAt, sourceUpdatedAt: null },
    themes: [{ sourceThemeId: `raw-${index}`, keyword: index ? 'Brightness' : 'Easy assembly', content: 'Saved Customers Say summary', mention: index + 1, positive: index + 1, negative: 0 }],
  }));
  const facts = { aggregation: aggregateCustomerThemes({ selectedAsins: asins, results, mappings: [] }), labels: [],
    decisions: results.map((_, index) => ({ sourceThemeId: `raw-${index}`, status: 'unavailable' as const, groupId: null, reason: 'model-result-unavailable', batchId: null })) };
  const selection = MarketThemeSelectionResponseSchema.parse({
    version: 'market-theme-selection-view/v1', base: entry,
    samples: asins.map((asin, index) => projectThemeSample({ asin, sourceIndex: index, product: { asin, title: `Lamp ${index + 1}`, sourceRank: index + 1 },
      productSource: { ref: `market-source:${'a'.repeat(64)}`, snapshotId: `market-input:${'b'.repeat(64)}`,
        payload: { data: asins.map((id, rank) => ({ asin: id, title: `Lamp ${rank + 1}`, ranking: rank + 1 })) } } })),
    baseline: deriveThemeSelection(facts, [], false, false, true), latestRevisionId: null, revision: null, history: [],
  });
  assert.equal(selection.baseline.status, 'complete');
  const server = await createServer({ configFile: false, cacheDir: 'test-results/theme-rule-vite', define: { 'process.env': '{}' },
    plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const writes: string[] = [], errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml(url.pathname,
      '<!doctype html><html><body style="margin:24px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-theme-browser-harness.tsx"></script></body></html>') });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') writes.push(url.pathname);
    if (url.pathname.endsWith(`/runs/${themeRunId}`)) return route.fulfill({ json: themeRuleRun() });
    if (url.pathname.endsWith('/theme-selection')) return route.fulfill({ json: selection });
    if (url.pathname.endsWith('/details')) {
      const value = themeDetails(url); value.report = entry;
      return route.fulfill({ json: value });
    }
    if (url.pathname.endsWith('/evidence')) {
      const value = themeEvidence(url); value.report = entry; value.evidence.analysis = null;
      return route.fulfill({ json: value });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${origin}/?themeRun=${themeRunId}`);
  await page.getByRole('button', { name: '类目买家评论见解', exact: true }).click();
  await page.getByText('Easy assembly', { exact: true }).first().waitFor();
  await page.getByText('报告统计口径与完整证据', { exact: true }).click();
  await page.getByText('规则数据已完整', { exact: true }).last().waitFor();
  assert.match(await page.getByLabel('已保存主题报告').innerText(), /原主题条目/);
  assert.match(await page.getByLabel('已保存主题报告').innerText(), /语义归组未启用/);
  assert.doesNotMatch(await page.getByLabel('已保存主题报告').innerText(), /模型结果不可用|已校验的模型成员|等待模型/);
  await page.getByRole('button', { name: '查看第 1 组原主题', exact: true }).click();
  await page.getByRole('button', { name: '查看完整摘要与来源', exact: true }).first().click();
  await page.getByText('此任务未启用语义归组，原主题与摘要仍保留。', { exact: true }).waitFor();
  await mkdir('test-results/market-theme-rule-page', { recursive: true });
  await page.screenshot({ path: 'test-results/market-theme-rule-page/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: 'test-results/market-theme-rule-page/mobile.png', fullPage: true });
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
