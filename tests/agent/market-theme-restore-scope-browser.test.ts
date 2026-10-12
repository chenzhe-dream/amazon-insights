import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { themeRuleRun, themeEntry } from './helpers/market-theme-page-fixture';
const missing = '60000000-0000-4000-8000-000000000099';
const harness = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{MarketThemeSection}from'/app/market-theme-section';function App(){const q=new URL(location.href).searchParams;const [s,set]=useState({marketplace:'US',nodeIdPath:q.get('themeNode')||'',fromMonth:'2026-08',toMonth:'2026-08'});return <MarketThemeSection maxMonth="2026-08" selection={s} onSelectionChange={p=>set(v=>{const n={...v,...p};const u=new URL(location.href);u.searchParams.set('themeNode',n.nodeIdPath);history.replaceState(null,'',u);return n})}/>};createRoot(document.getElementById('root')).render(<App/>);`;
test('failed target retains history and URL; complete query draft survives reload', { timeout: 120000 }, async (t) => {
    const server = await createServer({ configFile: false, cacheDir: 'test-results/theme-scope-vite', define: { 'process.env': '{}' }, plugins: [{ name: 'scope-harness', resolveId(id) { if (id === '/scope-harness.tsx')
                    return id; }, load(id) { if (id === '/scope-harness.tsx')
                    return harness; } }, react()], server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false } });
    await server.listen();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const origin = server.resolvedUrls!.local[0].replace(/\/$/, ''), page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const base = themeRuleRun().run;
    base.history.push(themeEntry(true));
    let writes = 0;
    await page.route('**/*', async (route) => { const r = route.request(), u = new URL(r.url()); if (u.origin !== origin)
        return route.abort(); if (r.isNavigationRequest())
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/scope-harness.tsx"></script>' }); if (!u.pathname.startsWith('/api/'))
        return route.continue(); if (r.method() !== 'GET')
        writes++; return route.fulfill(u.pathname.endsWith('/runs/' + base.id) ? { json: { run: base } } : { status: 404, json: { error: { message: 'synthetic missing' } } }); });
    await page.goto(`${origin}/?themeRun=${base.id}&themeNode=999&shapeRun=other`);
    await page.getByText('任务进度、重试与历史报告', { exact: true }).click();
    await page.getByLabel('报告版本').selectOption(themeEntry(true).attemptId);
    await page.getByText('恢复已有主题任务', { exact: true }).click();
    await page.getByLabel('任务 UUID').fill(missing);
    await page.getByRole('button', { name: '读取任务', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '目标任务读取失败' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('themeRun'), base.id);
    assert.equal(await page.getByLabel('报告版本').inputValue(), themeEntry(true).attemptId);
    assert.equal(await page.getByLabel('类目路径').inputValue(), '999');
    await page.reload();
    await page.getByText('任务进度、重试与历史报告', { exact: true }).click();
    await page.getByLabel('报告版本').waitFor();
    assert.equal(await page.getByLabel('类目路径').inputValue(), '999');
    assert.equal(writes, 0);
});
test('nonempty query draft survives initial read and reload independently', { timeout: 120000 }, async (t) => {
    const server = await createServer({ configFile: false, cacheDir: 'test-results/theme-draft-vite', define: { 'process.env': '{}' }, plugins: [{ name: 'scope-harness', resolveId(id) { if (id === '/scope-harness.tsx')
                    return id; }, load(id) { if (id === '/scope-harness.tsx')
                    return harness; } }, react()], server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false } });
    await server.listen();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const origin = server.resolvedUrls!.local[0].replace(/\/$/, ''), page = await browser.newPage();
    const base = themeRuleRun().run;
    await page.route('**/*', async (route) => { const r = route.request(), u = new URL(r.url()); if (u.origin !== origin)
        return route.abort(); if (r.isNavigationRequest())
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/scope-harness.tsx"></script>' }); if (!u.pathname.startsWith('/api/'))
        return route.continue(); return route.fulfill(u.pathname.endsWith('/runs/' + base.id) ? { json: { run: base } } : { status: 404, json: {} }); });
    await page.goto(`${origin}/?themeRun=${base.id}&themeNode=999`);
    await page.getByText('任务进度、重试与历史报告', { exact: true }).click();
    await page.getByLabel('报告版本').waitFor();
    assert.equal(await page.getByLabel('类目路径').inputValue(), '999');
    await page.reload();
    await page.getByText('任务进度、重试与历史报告', { exact: true }).click();
    await page.getByLabel('报告版本').waitFor();
    assert.equal(await page.getByLabel('类目路径').inputValue(), '999');
});
// Synthetic runs and bounded response gates: no source/model requests are allowed.
async function fixture(t: any) {
    const server = await createServer({ configFile: false, cacheDir: 'test-results/theme-race-vite', define: { 'process.env': '{}' }, plugins: [{ name: 'scope-harness', resolveId(id) { if (id === '/scope-harness.tsx')
                    return id; }, load(id) { if (id === '/scope-harness.tsx')
                    return harness; } }, react()], server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false } });
    await server.listen();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const origin = server.resolvedUrls!.local[0].replace(/\/$/, ''), page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const base = themeRuleRun().run;
    base.history.push(themeEntry(true));
    const second = structuredClone(base);
    second.id = missing;
    second.scope = { ...base.scope, nodeIdPath: '12345', marketplace: 'DE', currency: 'EUR', fromMonth: '2026-04', toMonth: '2026-05' };
    second.params = { ...base.params, memberCount: 5, poolSize: 50 };
    for (const e of [second.currentReport, second.latestSavedReport, ...second.history])
        if (e) {
            e.report.moduleRunId = second.id;
            e.report.scope = second.scope;
        }
    const state = { writes: 0, reads: 0, status: 0, hold: false, release: () => { }, entered: () => { }, response: base };
    await page.route('**/*', async (route) => {
        const r = route.request(), u = new URL(r.url());
        if (u.origin !== origin)
            return route.abort();
        if (r.isNavigationRequest())
            return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/scope-harness.tsx"></script>' });
        if (!u.pathname.startsWith('/api/'))
            return route.continue();
        if (r.method() !== 'GET')
            state.writes++;
        if (/\/runs\/[\w-]+$/.test(u.pathname)) {
            state.reads++;
            const run = u.pathname.endsWith(second.id) ? second : state.response, status = state.status;
            state.status = 0;
            if (state.hold) {
                state.hold = false;
                state.entered();
                await new Promise<void>(resolve => { const timer = setTimeout(resolve, 6000); state.release = () => { clearTimeout(timer); resolve(); }; });
            }
            return route.fulfill(status ? { status, json: { error: { message: 'synthetic denied' } } } : { json: { run } }).catch(() => { });
        }
        return route.fulfill({ status: 404, json: {} });
    });
    async function open(node = '999') { await page.goto(`${origin}/?themeRun=${base.id}&themeNode=${node}&shapeRun=other&keywordNode=keep`); await page.getByText('任务进度、重试与历史报告', { exact: true }).click(); await page.getByLabel('报告版本').waitFor(); await page.getByText('恢复已有主题任务', { exact: true }).click(); }
    async function restore(id: string) { await page.getByLabel('任务 UUID').fill(id); await page.getByRole('button', { name: '读取任务', exact: true }).click(); }
    return { page, base, second, state, open, restore };
}
test('target cancellation and latest target win; late reads preserve all edited query fields', { timeout: 120000 }, async (t) => {
    const { page, base, second, state, open, restore } = await fixture(t);
    await open();
    await page.getByLabel('报告版本').selectOption(themeEntry(true).attemptId);
    state.hold = true;
    const entered = new Promise<void>(r => state.entered = r);
    await restore(second.id);
    await entered;
    assert.equal(new URL(page.url()).searchParams.get('themeRun'), base.id);
    assert.equal(await page.getByRole('button', { name: '重新拉取', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '取消读取', exact: true }).click();
    state.release();
    assert.equal(await page.getByLabel('报告版本').inputValue(), themeEntry(true).attemptId);
    state.hold = true;
    const nextEntered = new Promise<void>(r => state.entered = r);
    await restore(second.id);
    await nextEntered;
    const releaseOld = state.release;
    await page.getByText('分析月份与样本设置', { exact: true }).click();
    await page.getByRole('button', { name: '英国站', exact: true }).click();
    await page.getByLabel('类目路径').fill('777');
    await page.getByLabel('完整月份').fill('2026-07');
    await page.getByLabel('起始月份').fill('2026-06');
    await page.getByLabel('主题样本数量').fill('7');
    await page.getByLabel('商品池数量').fill('70');
    releaseOld();
    await page.waitForURL(u => u.searchParams.get('themeRun') === second.id);
    assert.equal(await page.getByLabel('类目路径').inputValue(), '777');
    assert.equal(await page.getByLabel('主题样本数量').inputValue(), '7');
    assert.equal(await page.getByLabel('商品池数量').inputValue(), '70');
    assert.equal(await page.getByLabel('完整月份').inputValue(), '2026-07');
    assert.equal(await page.getByLabel('起始月份').inputValue(), '2026-06');
    assert.equal(await page.getByRole('button', { name: '英国站', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(new URL(page.url()).searchParams.get('shapeRun'), 'other');
    assert.equal(new URL(page.url()).searchParams.get('keywordNode'), 'keep');
    await page.getByText(/查询条件与下方任务不同/).waitFor();
    state.hold = true;
    const oldEntered = new Promise<void>(r => state.entered = r);
    await restore(base.id);
    await oldEntered;
    const oldRelease = state.release;
    await page.getByLabel('任务 UUID').fill(second.id);
    await page.getByRole('button', { name: '读取目标中…', exact: true }).click();
    await page.getByRole('button', { name: '取消读取', exact: true }).waitFor({ state: 'hidden' });
    oldRelease();
    const refreshed = page.waitForResponse(r => r.url().endsWith('/runs/' + second.id));
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await refreshed;
    assert.equal(new URL(page.url()).searchParams.get('themeRun'), second.id);
    assert.equal(state.writes, 0);
});
test('same-task reads retain history and query; stale current response cannot overwrite refresh', { timeout: 120000 }, async (t) => {
    const { page, base, state, open, restore } = await fixture(t);
    await open();
    await page.getByLabel('报告版本').selectOption(themeEntry(true).attemptId);
    state.hold = true;
    const entered = new Promise<void>(r => state.entered = r);
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await entered;
    const release = state.release;
    state.response = { ...base, status: 'cancelled' };
    await restore(base.id);
    await page.getByRole('heading', { name: '分析已取消', exact: true }).waitFor();
    release();
    await page.getByRole('heading', { name: '分析已取消', exact: true }).waitFor();
    assert.equal(await page.getByLabel('报告版本').inputValue(), themeEntry(true).attemptId);
    assert.equal(await page.getByLabel('类目路径').inputValue(), '999');
    assert.equal(state.writes, 0);
});
test('different target403 retains authorized report; same/current403 and401 clear revoked report', { timeout: 120000 }, async (t) => {
    const { page, base, second, state, open, restore } = await fixture(t);
    await open();
    state.status = 403;
    await restore(second.id);
    await page.getByRole('alert').filter({ hasText: '目标任务读取失败' }).waitFor();
    assert.equal(await page.getByLabel('报告版本').count(), 1);
    state.status = 403;
    await restore(base.id);
    await page.getByRole('alert').filter({ hasText: '未读取到任务' }).waitFor();
    assert.equal(await page.getByLabel('报告版本').count(), 0);
    await open();
    state.status = 403;
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '状态读取失败' }).waitFor();
    assert.equal(await page.getByLabel('报告版本').count(), 0);
    await open();
    state.status = 401;
    await restore(second.id);
    await page.getByRole('alert').filter({ hasText: '未读取到任务' }).waitFor();
    assert.equal(await page.getByLabel('报告版本').count(), 0);
    assert.equal(state.writes, 0);
});
test('empty deep link fills once; no-report failure text is truthful; unmount cancels target', { timeout: 120000 }, async (t) => {
    const { page, base, second, state, open, restore } = await fixture(t);
    await open('');
    assert.equal(await page.getByLabel('类目路径').inputValue(), base.scope.nodeIdPath);
    await restore(second.id);
    await page.waitForURL(u => u.searchParams.get('themeRun') === second.id);
    assert.equal(await page.getByLabel('类目路径').inputValue(), '12345');
    state.hold = true;
    const entered = new Promise<void>(r => state.entered = r);
    await restore(base.id);
    await entered;
    const release = state.release;
    await page.goto(page.url());
    release();
    await page.getByText('任务进度、重试与历史报告', { exact: true }).click();
    await page.getByLabel('报告版本').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('themeRun'), second.id);
    assert.equal(await page.getByLabel('类目路径').inputValue(), '12345');
    await page.goto(new URL('/', page.url()).href);
    await page.getByText('任务进度、重试与历史报告', { exact: true }).click();
    await page.getByText('恢复已有主题任务', { exact: true }).click();
    state.status = 404;
    await restore(base.id);
    await page.getByRole('alert').filter({ hasText: '未读取到任务' }).waitFor();
    assert.equal(await page.getByText(/仍显示原任务/).count(), 0);
    assert.equal(state.writes, 0);
});
test('nested translation write locks restore until settled and target read locks new writes', { timeout: 120000 }, async (t) => {
    const { page, base, second, state, open, restore } = await fixture(t);
    await open();
    let release: () => void = () => { };
    let started: () => void = () => { };
    const entered = new Promise<void>(r => started = r);
    let writes = 0;
    await page.route('**/translations?*', route => route.fulfill({ json: { report: base.currentReport, items: [] } }));
    await page.route('**/translations', async (route) => { writes++; started(); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 6000); release = () => { clearTimeout(timer); resolve(); }; }); await route.fulfill({ status: 503, json: { error: { message: 'synthetic write complete' } } }).catch(() => { }); });
    await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).first().click();
    await entered;
    assert.equal(await page.getByRole('button', { name: '读取任务', exact: true }).isDisabled(), true);
    release();
    await page.getByRole('button', { name: '读取任务', exact: true }).waitFor();
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(b => b.textContent === '读取任务') as HTMLButtonElement)?.disabled);
    state.hold = true;
    const targetEntered = new Promise<void>(r => state.entered = r);
    await restore(second.id);
    await targetEntered;
    assert.equal(await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).first().isDisabled(), true);
    await page.getByRole('button', { name: '取消读取', exact: true }).click();
    state.release();
    assert.equal(writes, 1);
});
test('overlapping translation owners keep restore locked until both settle', { timeout: 120000 }, async (t) => {
    const { page, base, state, open } = await fixture(t);
    await open();
    await page.route('**/details?*', async (route) => { const { themeDetails } = await import('./helpers/market-theme-page-fixture'); const detail = themeDetails(new URL(route.request().url())); detail.report = base.currentReport!; await route.fulfill({ json: detail }); });
    await page.route('**/translations?*', route => route.fulfill({ json: { report: base.currentReport, items: [] } }));
    const releases: (() => void)[] = [];
    let entered: () => void = () => { }, count = 0;
    await page.route('**/translations', async (route) => { count++; entered(); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 6000); releases.push(() => { clearTimeout(timer); resolve(); }); }); await route.fulfill({ status: 503, json: { error: { message: 'synthetic settled ' + count } } }).catch(() => { }); });
    await page.getByText('报告统计口径与完整证据', { exact: true }).click();
    await page.getByRole('button', { name: '重读明细', exact: true }).click();
    await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).nth(1).waitFor();
    const first = new Promise<void>(r => entered = r);
    await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).first().click();
    await first;
    assert.equal(await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).isDisabled(), false);
    const second = new Promise<void>(r => entered = r);
    await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).click();
    await second;
    releases[0]();
    await page.getByText(/synthetic settled/).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '读取任务', exact: true }).isDisabled(), true);
    releases[1]();
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(b => b.textContent === '读取任务') as HTMLButtonElement)?.disabled);
    assert.equal(count, 2);
    assert.equal(state.writes, 0);
});
test('nested selection save locks restore and target reads prevent selection writes', { timeout: 120000 }, async (t) => {
    const { page, base, second, state, open, restore } = await fixture(t);
    const { aggregateCustomerThemes } = await import('../../server/domain/market-research/customer-themes');
    const { deriveThemeSelection } = await import('../../server/domain/market-research/customer-theme-selection');
    const ids = base.currentReport!.report.selectedAsins;
    const baseline = deriveThemeSelection({ aggregation: aggregateCustomerThemes({ selectedAsins: ids, results: ids.map((asin, i) => ({ asin, status: 'success', source: { sourceRecordId: `s${i}`, fetchedAt: base.createdAt, sourceUpdatedAt: null }, themes: [] })), mappings: [] }), labels: [], decisions: [] }, [], false);
    const view = { version: 'market-theme-selection-view/v1', base: base.currentReport, samples: [], baseline, latestRevisionId: null, revision: null, history: [] };
    let writes = 0, release: () => void = () => { }, entered: () => void = () => { };
    await page.route('**/theme-selection', async (route) => { if (route.request().method() === 'POST') {
        writes++;
        entered();
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 6000); release = () => { clearTimeout(timer); resolve(); }; });
    } await route.fulfill({ json: view }).catch(() => { }); });
    await open();
    await page.getByRole('button', { name: '移除', exact: true }).first().waitFor();
    page.on('dialog', d => d.accept());
    const saved = new Promise<void>(r => entered = r);
    await page.getByRole('button', { name: '移除', exact: true }).first().click();
    await saved;
    assert.equal(await page.getByRole('button', { name: '读取任务', exact: true }).isDisabled(), true);
    release();
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(b => b.textContent === '读取任务') as HTMLButtonElement)?.disabled);
    state.hold = true;
    const reading = new Promise<void>(r => state.entered = r);
    await restore(second.id);
    await reading;
    assert.equal(await page.getByRole('button', { name: '移除', exact: true }).first().isDisabled(), true);
    await page.getByRole('button', { name: '取消读取', exact: true }).click();
    state.release();
    assert.equal(writes, 1);
});
