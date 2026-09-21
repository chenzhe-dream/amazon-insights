import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductContext, decideProductCandidate, evaluateTextAction, type ProductContext } from '../../shared/product-structure-rules';

function context(title: string, need: string, features: string[] = []): ProductContext {
  return buildProductContext({ scope: { organizationId: 'org', projectId: 'semantics', marketplace: 'US', asins: ['item'], inputRevision: '1' }, asin: 'item', title, features,
    evidence: [{ id: 'item:need', text: need, kind: 'voc', role: 'need', scope: 'asin', asin: 'item' }] });
}
function action(c: ProductContext, text: string) { return evaluateTextAction(c, text, { needEvidenceRefs: ['item:need'] }); }

test('wax dimming and generic illumination do not manufacture a reading prerequisite', () => {
  const c = context('Candle warmer lamp', '希望支持无级调光或提供更多亮度档位');
  const d = action(c, '验证无级调光、亮度档位与照明均匀性，比较眩光和调节效果');
  assert.equal(d.outcome, 'supported');
  assert.ok(!d.matchedConditions.some(value => value.predicate.attribute === 'reading_illumination'));
});

test('explicit reading still requires its purpose and dual-purpose evidence remains usable', () => {
  const need = '阅读时眩光较强，希望改善阅读照明';
  assert.equal(action(context('Candle warmer lamp', need), '验证阅读照明眩光').outcome, 'rejected');
  assert.equal(action(context('Candle warmer lamp', need, ['可作为阅读灯使用']), '验证阅读照明眩光').outcome, 'supported');
});

test('Chinese front and rear wheel actions require physical wheels', () => {
  for (const part of ['前轮', '后轮', '轮子']) {
    const text = `复现${part}故障并验证改进样件`;
    const wheel = context('3 wheel scooter', `${part}容易故障`);
    assert.equal(action(wheel, text).outcome, 'supported');
    const absent = action(context('Snow sled', `${part}容易故障`, ['无轮']), text);
    assert.equal(absent.outcome, 'rejected');
    assert.ok(absent.matchedConditions.some(value => value.predicate.attribute === 'wheels' && value.passed === false));
  }
});

test('unrecognized structure does not let an unrelated same-ASIN need support any action', () => {
  const c = context('Novel product', '包装容易破损，希望改善运输保护');
  for (const text of ['验证容量和取放开口', '希望改善蓝牙连接并减少断线', '验证无级调光与亮度档位']) {
    const d = action(c, text);
    assert.equal(d.outcome, 'needs_check', text);
    assert.equal(d.reasonCode, 'need_missing', text);
  }
  assert.equal(action(c, '检查包装易损位置并验证运输保护').outcome, 'supported');
});

test('specific same-source needs keep capacity, quoted unknown designs and preservation proposals', () => {
  for (const [need, text] of [
    ['容量不足，取放不方便', '验证容量和取放开口'],
    ['取用抽拉盒时卡顿，希望改善抽拉行程', '围绕「取用抽拉盒时卡顿」制作改进样件并验证效果'],
    ['握持很舒适', '保留舒适体验并验证改版后的体验'],
    ['Bluetooth connection drops repeatedly', 'Verify Bluetooth connection reliability'],
  ]) assert.equal(action(context('Novel product', need), text).outcome, 'supported', need);
});

test('unknown new attributes still need related demand without requiring existing hardware', () => {
  const candidate = { id: 'novel', asin: 'item', kind: 'proposal' as const, text: '新增抽拉盒以改善取用卡顿', needEvidenceRefs: ['item:need'], addsAttributes: ['pull_out_box'], validation: ['验证抽拉行程与取用效果'] };
  assert.equal(decideProductCandidate(context('Novel product', '包装运输破损'), candidate).outcome, 'needs_check');
  assert.equal(decideProductCandidate(context('Novel product', '取用时卡顿，希望加入抽拉盒'), candidate).outcome, 'supported');
});

test('temperature and quality control do not support grip work merely because a handle exists', () => {
  for (const need of ['希望实现亮度和温度分离控制', '希望提高短期故障控制，减少停止工作', 'Temperature control fluctuates', 'Improve quality control']) {
    const d = action(context('Candle warmer lamp with handlebar', need), '验证握持舒适度与操作力度');
    assert.equal(d.outcome, 'needs_check', need);
    assert.equal(d.reasonCode, 'need_missing', need);
  }
  for (const need of ['手部控制比较费力', '转向操控费力', 'Hand control is awkward', 'Steering takes too much effort']) {
    assert.equal(action(context('Scooter with handlebar', need), '验证握持舒适度与操作力度').outcome, 'supported', need);
  }
});

test('a timer need alone does not support reading glare work on an established reading lamp', () => {
  for (const need of ['定时关闭不准确', 'The timer shuts off too early']) {
    const c = context('Reading lamp', need);
    assert.equal(action(c, '验证阅读照明眩光').reasonCode, 'need_missing', need);
    assert.equal(action(c, need.includes('timer') ? 'Verify timer shutoff accuracy' : '验证定时关闭准确性').outcome, 'supported', need);
    assert.equal(action(c, need.includes('timer') ? 'Verify the reading lamp timer accuracy' : '验证阅读灯定时关闭准确性').outcome, 'supported', need);
  }
  assert.equal(action(context('Reading lamp', '阅读时眩光较强'), '验证阅读照明眩光').outcome, 'supported');
});
