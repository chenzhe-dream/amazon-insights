import assert from 'node:assert/strict';
import test from 'node:test';
import type { Route } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { themeRuleRun, themeRun, themeEntry } from './helpers/market-theme-page-fixture';
import { MarketThemeRunResponseSchema } from '../../shared/market-module-contracts';
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
function responseGates(watchdogMs = 20000) {
    const pending = new Set<(released: boolean) => void>();
    const failures: Error[] = [];
    return {
        async wait(route: Route, ownRelease: (release: () => void) => void) {
            const released = await new Promise<boolean>(resolve => {
                const settle = (released: boolean) => {
                    if (!pending.delete(settle)) return;
                    clearTimeout(timer);
                    resolve(released);
                };
                const timer = setTimeout(() => {
                    failures.push(new Error(`Response gate watchdog expired: ${route.request().method()} ${route.request().url()}`));
                    settle(false);
                }, watchdogMs);
                pending.add(settle);
                ownRelease(() => settle(true));
            });
            if (!released) await route.abort().catch(() => {});
            return released;
        },
        abortAll() { for (const settle of pending) settle(false); },
        assertHealthy() { assert.equal(failures.length, 0, failures.map(error => error.message).join('\n')); },
    };
}
async function fixture(t: any) {
    const server = await createServer({ configFile: false, cacheDir: 'test-results/theme-race-vite', define: { 'process.env': '{}' }, plugins: [{ name: 'scope-harness', resolveId(id) { if (id === '/scope-harness.tsx')
                    return id; }, load(id) { if (id === '/scope-harness.tsx')
                    return harness; } }, react()], server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false } });
    await server.listen();
    const browser = await chromium.launch();
    const gates = responseGates();
    t.after(async () => {
        gates.abortAll();
        try { await page.unrouteAll({ behavior: 'wait' }); }
        finally {
            try { await browser.close(); }
            finally { try { await server.close(); } finally { gates.assertHealthy(); } }
        }
    });
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
                if (!await gates.wait(route, release => { state.release = release; state.entered(); })) return;
            }
            return route.fulfill(status ? { status, json: { error: { message: 'synthetic denied' } } } : { json: { run } }).catch(() => { });
        }
        return route.fulfill({ status: 404, json: {} });
    });
    async function open(node = '999') { await page.goto(`${origin}/?themeRun=${base.id}&themeNode=${node}&shapeRun=other&keywordNode=keep`); await page.getByText('任务进度、重试与历史报告', { exact: true }).click(); await page.getByLabel('报告版本').waitFor(); await page.getByText('恢复已有主题任务', { exact: true }).click(); }
    async function restore(id: string) { await page.getByLabel('任务 UUID').fill(id); await page.getByRole('button', { name: '读取任务', exact: true }).click(); }
    return { page, base, second, state, gates, open, restore };
}

for (const kind of ['retry', 'cancel', 'submit', 'recollect'] as const) test(`current403 invalidates pending ${kind} adoption and allows explicit recovery`, { timeout: 30000 }, async (t) => {
    const { page, base, second, state, gates, open, restore } = await fixture(t);
    if (kind === 'retry' || kind === 'cancel') base.steps = themeRun(kind === 'cancel').run.steps;
    MarketThemeRunResponseSchema.parse({ run: base });
    await open();
    state.status = 403;
    state.hold = true;
    const reading = new Promise<void>(resolve => state.entered = resolve);
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await reading;
    const releaseRead = state.release;
    let releaseAction = () => {}, enteredAction = () => {}, actionWrites = 0;
    const actionPending = new Promise<void>(resolve => enteredAction = resolve);
    const gate = (route: Route) => gates.wait(route, release => { releaseAction = release; enteredAction(); });
    t.after(() => { releaseRead(); releaseAction(); });
    if (kind === 'retry' || kind === 'cancel') {
        await page.route(`**/runs/${base.id}/${kind}`, route => {
            actionWrites++;
            return route.fulfill({ json: kind === 'retry' ? { moduleRunId: base.id, stepIds: [] } : { moduleRunId: base.id, cancelled: true } });
        });
        await page.route(`**/runs/${base.id}`, async route => {
            if (!await gate(route)) return;
            await route.fulfill({ json: { run: base } }).catch(() => {});
        });
    } else {
        await page.route('**/studies', route => {
            actionWrites++;
            const id = route.request().headers()['idempotency-key'];
            return route.fulfill({ json: { study: { id, scope: { ...base.scope, ...route.request().postDataJSON(), researchId: id }, createdAt: base.createdAt } } });
        });
        await page.route('**/customer-themes', async route => {
            actionWrites++;
            const next = structuredClone(second);
            next.scope.researchId = new URL(route.request().url()).pathname.split('/').at(-2)!;
            for (const entry of [next.currentReport, next.latestSavedReport, ...next.history]) if (entry) entry.report.scope = next.scope;
            MarketThemeRunResponseSchema.parse({ run: next });
            if (!await gate(route)) return;
            await route.fulfill({ json: { run: next } }).catch(() => {});
        });
    }
    const button = kind === 'retry' ? '重试 B0THEME002' : kind === 'cancel' ? '取消本次分析' : kind === 'submit' ? '拉取见解' : '重新拉取';
    await page.getByRole('button', { name: button, exact: true }).click();
    await actionPending;
    releaseRead();
    await page.getByRole('alert').filter({ hasText: '状态读取失败' }).waitFor();
    assert.equal(await page.getByLabel('已保存主题报告').count(), 0);
    releaseAction();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
    assert.equal(await page.getByLabel('已保存主题报告').count(), 0, 'Revoked report must not be resurrected by an older mutation');
    assert.equal(await page.getByRole('alert').filter({ hasText: '状态读取失败' }).count(), 1);
    assert.equal(new URL(page.url()).searchParams.get('themeRun'), base.id);
    assert.equal(await page.getByLabel('类目路径').inputValue(), '999');
    assert.equal(actionWrites, kind === 'retry' || kind === 'cancel' ? 1 : 2);
    await page.unroute(`**/runs/${base.id}`);
    await restore(second.id);
    await page.waitForURL(u => u.searchParams.get('themeRun') === second.id);
    assert.equal(await page.getByLabel('已保存主题报告').count(), 1);
    assert.equal(await page.getByRole('button', { name: '拉取见解', exact: true }).isDisabled(), false);
});
test('revoked retry cannot finish a newer retry or change its idempotency key', { timeout: 30000 }, async (t) => {
    const { page, base, state, gates, open, restore } = await fixture(t);
    base.steps = themeRun().run.steps;
    await open();
    state.status = 403; state.hold = true;
    const reading = new Promise<void>(resolve => state.entered = resolve);
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await reading;
    const releaseRead = state.release;
    const releases: (() => void)[] = [], keys: string[] = [];
    let entered = () => {}, reads = 0;
    await page.route(`**/runs/${base.id}/retry`, route => {
        keys.push(route.request().headers()['idempotency-key']);
        return route.fulfill({ json: { moduleRunId: base.id, stepIds: [] } });
    });
    const actionRoute = async (route: any) => {
        reads++;
        if (!await gates.wait(route, release => { releases.push(release); entered(); })) return;
        await route.fulfill({ json: { run: base } }).catch(() => {});
    };
    t.after(() => { releaseRead(); releases.forEach(release => release()); });
    await page.route(`**/runs/${base.id}`, actionRoute);
    const first = new Promise<void>(resolve => entered = resolve);
    await page.getByRole('button', { name: '重试 B0THEME002', exact: true }).click();
    await first;
    releaseRead();
    await page.getByRole('alert').filter({ hasText: '状态读取失败' }).waitFor();
    await page.unroute(`**/runs/${base.id}`, actionRoute);
    await restore(base.id);
    await page.getByLabel('报告版本').waitFor();
    await page.route(`**/runs/${base.id}`, actionRoute);
    const second = new Promise<void>(resolve => entered = resolve);
    await page.getByRole('button', { name: '重试 B0THEME002', exact: true }).click();
    await second;
    releases[0]();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
    assert.equal(await page.getByRole('button', { name: '读取任务', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '重试 B0THEME002', exact: true }).isDisabled(), true);
    assert.equal(reads, 2, 'Old finally must not trigger another current read');
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], 'An interrupted command retains its idempotency key');
    await page.unroute(`**/runs/${base.id}`, actionRoute);
    releases[1]();
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(b => b.textContent === '读取任务') as HTMLButtonElement)?.disabled);
});

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
    const { page, base, second, state, gates, open, restore } = await fixture(t);
    await open();
    let release: () => void = () => { };
    let started: () => void = () => { };
    const entered = new Promise<void>(r => started = r);
    let writes = 0;
    await page.route('**/translations?*', route => route.fulfill({ json: { report: base.currentReport, items: [] } }));
    await page.route('**/translations', async (route) => { writes++; if (!await gates.wait(route, owned => { release = owned; started(); })) return; await route.fulfill({ status: 503, json: { error: { message: 'synthetic write complete' } } }).catch(() => { }); });
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
    const { page, base, state, gates, open } = await fixture(t);
    await open();
    await page.route('**/details?*', async (route) => { const { themeDetails } = await import('./helpers/market-theme-page-fixture'); const detail = themeDetails(new URL(route.request().url())); detail.report = base.currentReport!; await route.fulfill({ json: detail }); });
    await page.route('**/translations?*', route => route.fulfill({ json: { report: base.currentReport, items: [] } }));
    const releases: (() => void)[] = [];
    let entered: () => void = () => { }, count = 0;
    await page.route('**/translations', async (route) => { count++; if (!await gates.wait(route, release => { releases.push(release); entered(); })) return; await route.fulfill({ status: 503, json: { error: { message: 'synthetic settled ' + count } } }).catch(() => { }); });
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
for (const automatic of [false, true]) test(`${automatic ? 'automatic poll' : 'manual current read'} defers report replacement through nested write settlement`, { timeout: 30000 }, async (t) => {
    const { page, base, state, gates, open } = await fixture(t);
    if (automatic) base.steps = [{ id: '60000000-0000-4000-8000-000000000006', kind: 'report', status: 'running', latestAttemptId: null, attemptCount: 0, current: true, canRetry: false, asin: null, errorCode: null }];
    await open();
    const latest = structuredClone(base);
    latest.steps = [];
    latest.currentReport!.attemptId = '60000000-0000-4000-8000-000000000088';
    latest.latestSavedReport = latest.currentReport;
    latest.history = [latest.currentReport!, ...base.history];
    let releaseWrite = () => {}, enteredWrite = () => {}, writes = 0;
    const writing = new Promise<void>(resolve => enteredWrite = resolve);
    await page.route('**/translations', async route => {
        writes++;
        if (!await gates.wait(route, release => { releaseWrite = release; enteredWrite(); })) return;
        await route.fulfill({ status: 503, json: { error: { message: 'synthetic settled' } } }).catch(() => {});
    });
    t.after(() => releaseWrite());
    state.response = latest;
    state.hold = true;
    const reading = new Promise<void>(resolve => state.entered = resolve);
    if (!automatic) await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await reading;
    await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).first().click();
    await writing;
    const response = page.waitForResponse(r => r.url().endsWith('/runs/' + base.id));
    state.release();
    await response;
    // A following animation frame observes React's acceptance of the response.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('button', { name: '读取任务', exact: true }).isDisabled(), true, 'Current reads must retain pending writer lock');
    assert.equal(await page.getByLabel('报告版本').locator(`option[value="${latest.currentReport!.attemptId}"]`).count(), 0);
    releaseWrite();
    await page.getByLabel('报告版本').locator(`option[value="${latest.currentReport!.attemptId}"]`).waitFor({ state: 'attached' });
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(b => b.textContent === '读取任务') as HTMLButtonElement)?.disabled);
    assert.equal(writes, 1);
});

for (const status of [401, 403]) test(`current ${status} revokes report during a pending nested write`, { timeout: 30000 }, async (t) => {
    const { page, state, gates, open } = await fixture(t);
    await open();
    let release = () => {}, entered = () => {}, settled = false;
    const writing = new Promise<void>(resolve => entered = resolve);
    await page.route('**/translations', async route => {
        if (!await gates.wait(route, owned => { release = owned; entered(); })) return;
        settled = true;
        await route.fulfill({ status: 503, json: {} }).catch(() => {});
    });
    t.after(() => release());
    await page.getByRole('button', { name: '开始/继续中文翻译', exact: true }).first().click();
    await writing;
    state.status = status;
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '状态读取失败' }).waitFor();
    assert.equal(settled, false);
    assert.equal(await page.getByLabel('报告版本').count(), 0);
    release();
});

test('nested selection save locks restore and target reads prevent selection writes', { timeout: 120000 }, async (t) => {
    const { page, base, second, state, gates, open, restore } = await fixture(t);
    const { aggregateCustomerThemes } = await import('../../server/domain/market-research/customer-themes');
    const { deriveThemeSelection } = await import('../../server/domain/market-research/customer-theme-selection');
    const ids = base.currentReport!.report.selectedAsins;
    const baseline = deriveThemeSelection({ aggregation: aggregateCustomerThemes({ selectedAsins: ids, results: ids.map((asin, i) => ({ asin, status: 'success', source: { sourceRecordId: `s${i}`, fetchedAt: base.createdAt, sourceUpdatedAt: null }, themes: [] })), mappings: [] }), labels: [], decisions: [] }, [], false);
    const view = { version: 'market-theme-selection-view/v1', base: base.currentReport, samples: [], baseline, latestRevisionId: null, revision: null, history: [] };
    let writes = 0, release: () => void = () => { }, entered: () => void = () => { };
    await page.route('**/theme-selection', async (route) => { if (route.request().method() === 'POST') {
        writes++;
        if (!await gates.wait(route, owned => { release = owned; entered(); })) return;
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
