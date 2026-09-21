import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

test('report text expands in place; original template keeps sections 4–7 free of per-row decision controls', async t => {
  const server = await createServer({ configFile: false, define: { 'process.env': '{}' }, plugins: [react()], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/tests/agent/helpers/product-definition-inline-harness.html`);
  const card = page.locator('.final-oneliner-card').first();
  const originalNode = await card.locator('.definition-inline-fragment').first().elementHandle();
  assert.ok(originalNode);
  assert.equal(await card.locator('.definition-inline-asin-label').count(), 2);
  assert.equal(await card.locator('.definition-inline-asin-label').first().textContent(), '[B0DDX8MYKQ]');
  const before = await originalNode.textContent();
  const collapsedHeight = await originalNode.evaluate(node => node.clientHeight);
  const expand = card.getByRole('button', { name: '展开全文 ▾', exact: true }).first();
  await expand.click();
  assert.equal(await originalNode.evaluate(node => node.isConnected), true);
  assert.equal(await originalNode.textContent(), before);
  assert.ok(await originalNode.evaluate(node => node.clientHeight) > collapsedHeight);
  assert.equal(await card.locator('.definition-inline-fragment').count(), 2);
  await card.getByRole('button', { name: '收起 ▴', exact: true }).click();
  assert.equal(await originalNode.evaluate(node => node.clientHeight), collapsedHeight);

  const oneLiner = page.locator('.definition-full-original');
  const oneLinerText = await oneLiner.locator('.definition-synthesis-merged').textContent();
  await oneLiner.locator('summary').click();
  assert.equal(await oneLiner.locator('.definition-synthesis-merged').textContent(), oneLinerText);
  assert.equal(await oneLiner.locator('.definition-synthesis-merged').isVisible(), true);
  await oneLiner.locator('summary').click();

  for (const [sectionNumber, columns] of [[4, 7], [6, 5], [7, 6]]) {
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: new RegExp(`^${sectionNumber}\\.`) }) });
    assert.equal(await section.locator('thead th').count(), columns);
    assert.equal(await section.getByRole('columnheader', { name: '判定依据', exact: true }).count(), 0);
    assert.equal(await section.locator('.definition-inline-trigger-cell').count(), 0);
    const style = await section.locator('table').evaluate(table => ({ font: getComputedStyle(table).fontSize, layout: getComputedStyle(table).tableLayout }));
    assert.deepEqual(style, { font: '10px', layout: 'auto' });
    const body = section.locator('.definition-inline-text').filter({ has: page.getByRole('button', { name: '展开全文 ▾', exact: true }) }).first();
    const copyId = await body.locator('.definition-inline-copy').getAttribute('id');
    const stableCopy = section.locator(`[id="${copyId}"]`);
    const original = await stableCopy.textContent();
    await body.getByRole('button', { name: '展开全文 ▾', exact: true }).click();
    assert.equal(await stableCopy.textContent(), original);
    await stableCopy.locator('..').getByRole('button', { name: '收起 ▴', exact: true }).click();
  }
  const section4 = page.locator('section').filter({ has: page.getByRole('heading', { name: /^4\./ }) });
  assert.equal(await section4.getByText('不可从关键词推断适龄', { exact: true }).isVisible(), true);
  const section5 = page.locator('section').filter({ has: page.getByRole('heading', { name: /^5\./ }) });
  assert.equal(await section5.getByText('判定依据', { exact: true }).count(), 0);
  assert.ok((await section5.innerText()).includes('对应商品反馈'));
  const rules = page.locator('.analysis-rule-overview');
  await rules.locator(':scope > summary').click();
  assert.ok((await rules.innerText()).includes('核对适龄限制'));
  await rules.locator(':scope > summary').click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  assert.deepEqual(errors, []);
});
