import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductContext, decideProductCandidate, evaluateTextAction, groupCompatibleProducts, buildProductStructureCacheKey, buildAnalysisRuleTrace, RULE_DEFINITIONS, RULE_SET_VERSION, describeRulePredicate, ruleDefinitionFingerprint, type AnalysisInputScope, type ProductContext } from '../../shared/product-structure-rules';

const scope: AnalysisInputScope = { organizationId: 'org', projectId: 'project', marketplace: 'US', asins: ['snow', 'two', 'three', 'wax', 'read', 'box'], inputRevision: '1' };
function context(asin: string, title: string, features: string[] = [], need = '连接松动，需要提高连接强度'): ProductContext {
  return buildProductContext({ scope, asin, title, aliases: [title], features, evidence: [{ id: `${asin}:need`, text: need, kind: 'voc', role: 'need', scope: 'asin', asin }] });
}
function action(ctx: ProductContext, text: string) { return evaluateTextAction(ctx, text, { needEvidenceRefs: [`${ctx.asin}:need`] }); }

test('A01 snow preserves name and concrete strength action but stops wheel template', () => {
  const c = context('snow', 'Snow Scooter', ['雪地板底滑行，无轮']);
  assert.equal(c.title, 'Snow Scooter');
  assert.equal(c.attributes.wheels.state, 'absent');
  assert.equal(action(c, '验证连接强度和耐用性').outcome, 'supported');
  assert.equal(action(c, '加大轮距和轴承').outcome, 'rejected');
});

test('explicit singular and plural snow sled titles retain original text and bounded evidence', () => {
  const asin = 'B01M119PTN';
  for (const title of [
    'SportsStuff Kids Snow Sled – Durable Winter Sled, Scooter & Skate for Outdoor Snow Play',
    'SportsStuff Kids Snow Sleds – Durable Winter Sleds, Scooters & Skates for Outdoor Snow Play',
  ]) {
    const c = buildProductContext({ scope: { ...scope, asins: [asin] }, asin, title, aliases: ['Snow Scooter'] });
    assert.equal(c.title, title);
    assert.deepEqual(c.aliases, ['Snow Scooter']);
    assert.deepEqual(c.attributes.snow_slide, { state: 'supported', evidenceRefs: [`${asin}:title`] }, title);
    assert.equal(c.attributes.wheels.state, 'unknown');
    assert.equal(c.attributes.three_wheels.state, 'unknown');
    assert.equal(evaluateTextAction(c, '增加轮距').outcome, 'rejected');
    assert.deepEqual(groupCompatibleProducts([c])[0].asins, [asin]);
    assert.ok(groupCompatibleProducts([c])[0].key.endsWith(':snow_slide'));
  }
});

test('negative plural snow sled wording remains absent and cannot support a positive fact', () => {
  const c = context('snow', 'Winter equipment', ['No snow sleds']);
  assert.deepEqual(c.attributes.snow_slide, { state: 'absent', evidenceRefs: ['snow:feature:0'] });
  assert.equal(decideProductCandidate(c, { id: 'negative-plural', asin: 'snow', kind: 'fact', text: 'no snow sleds', claim: { attribute: 'snow_slide', state: 'absent' } }).outcome, 'supported');
  assert.equal(decideProductCandidate(c, { id: 'positive-plural', asin: 'snow', kind: 'fact', text: 'snow sleds', claim: { attribute: 'snow_slide' } }).outcome, 'rejected');
  assert.equal(c.attributes.wheels.state, 'unknown');
});

test('plural snow sled fact wording is grounded without accepting unrelated extra claims', () => {
  const c = context('snow', 'SportsStuff Kids Snow Sled');
  for (const text of ['snow sled', 'snow sleds']) {
    const fact = decideProductCandidate(c, { id: text, asin: 'snow', kind: 'fact', text, claim: { attribute: 'snow_slide' } });
    assert.equal(fact.outcome, 'supported', text);
    assert.ok(fact.evidenceRefs.includes('snow:title'));
  }
  assert.equal(decideProductCandidate(c, { id: 'compound-plural', asin: 'snow', kind: 'fact', text: 'snow sleds with Bluetooth speakers', claim: { attribute: 'snow_slide' } }).outcome, 'needs_check');
});

test('snow scooter names and category-only sled wording do not imply physical structure', () => {
  for (const title of ['Snow Scooter', 'Snow Scooters', 'Snow Sledding Accessories']) {
    const c = buildProductContext({ scope, asin: 'snow', title, category: 'Snow Sleds' });
    assert.equal(c.title, title);
    assert.equal(c.attributes.snow_slide.state, 'unknown', title);
    assert.equal(c.attributes.wheels.state, 'unknown', title);
    assert.equal(c.attributes.three_wheels.state, 'unknown', title);
    assert.equal(evaluateTextAction(c, '增加轮距').outcome, 'needs_check');
  }
});

test('plural sled evidence preserves a conflicting negative source for fact review', () => {
  const c = context('snow', 'Snow Sleds', ['No snow sleds']);
  assert.equal(c.attributes.snow_slide.state, 'unknown');
  assert.deepEqual(c.conflicts.find((entry) => entry.attribute === 'snow_slide')?.evidenceRefs, ['snow:feature:0', 'snow:title']);
  assert.equal(decideProductCandidate(c, { id: 'conflicting-plural', asin: 'snow', kind: 'fact', text: 'snow sleds', claim: { attribute: 'snow_slide' } }).outcome, 'needs_check');
});

test('source observations quote scoped VOC restrictions without turning needs into structure facts', () => {
  const text = '低幼用户｜不推荐，仅限 8 岁以上儿童；希望增加三轮';
  const c = buildProductContext({ scope, asin: 'snow', title: 'Snow Scooter', evidence: [
    { id: 'audience-observation', asin: 'snow', text, kind: 'voc', role: 'need', scope: 'asin', location: 'audiences' },
  ] });
  const candidate = { id: 'observation', asin: 'snow', kind: 'fact' as const, text, evidenceRefs: ['audience-observation'] };
  assert.equal(decideProductCandidate(c, candidate).outcome, 'needs_check');
  const observed = decideProductCandidate(c, { ...candidate, sourceObservation: 'audiences' });
  assert.equal(observed.outcome, 'supported');
  assert.deepEqual(observed.evidenceRefs, ['audience-observation']);
  assert.equal(c.attributes.three_wheels.state, 'unknown');
  for (const change of [
    { text: '三轮结构', claim: { attribute: 'three_wheels' } },
    { claim: { attribute: 'three_wheels' } },
    { conditions: [{ attribute: 'three_wheels' }] },
    { addsAttributes: ['three_wheels'] },
    { text: '适合低幼用户' },
  ]) assert.notEqual(decideProductCandidate(c, { ...candidate, sourceObservation: 'audiences', ...change }).outcome, 'supported');
  assert.equal(decideProductCandidate(c, { ...candidate, sourceObservation: 'scenarios' }).outcome, 'needs_check');
});

test('source observation escape hatch accepts only nonempty same-ASIN VOC records', () => {
  for (const source of [
    { text: '人群｜特征', kind: 'voc' as const, scope: 'asin' as const, asin: 'snow' },
    { text: '低幼用户｜不推荐', kind: 'attribute' as const, scope: 'asin' as const, asin: 'snow' },
    { text: '低幼用户｜不推荐', kind: 'voc' as const, scope: 'project' as const },
    { text: '低幼用户｜不推荐', kind: 'voc' as const, scope: 'asin' as const, asin: 'two' },
  ]) {
    const c = buildProductContext({ scope, asin: 'snow', title: 'Snow Scooter', evidence: [{ ...source, id: 'observation', role: 'need', location: 'audiences' }] });
    assert.notEqual(decideProductCandidate(c, { id: 'quote', asin: 'snow', kind: 'fact', text: source.text, evidenceRefs: ['observation'], sourceObservation: 'audiences' }).outcome, 'supported');
  }
});
test('A02 actual three wheels retain fact and useful stability action', () => {
  const c = context('three', '3 wheel scooter', [], '转弯时不稳定');
  assert.equal(decideProductCandidate(c, { id: 'fact', asin: c.asin, kind: 'fact', text: '现有三轮', claim: { attribute: 'three_wheels' } }).outcome, 'supported');
  assert.equal(action(c, '验证轮距与转弯稳定性').outcome, 'supported');
});
test('A03 audience alone neither changes two wheels nor proves three wheels', () => {
  const c = context('two', '2 wheel scooter', [], 'kids toddler');
  assert.equal(c.attributes.two_wheels.state, 'supported');
  assert.equal(action(c, '改为三轮').outcome, 'needs_check');
  assert.equal(decideProductCandidate(c, { id: 'false', asin: 'two', kind: 'fact', text: '已有三轮', claim: { attribute: 'three_wheels' } }).outcome, 'rejected');
});
test('A04 wax heating and A05 reading lighting use distinct purposes', () => {
  const wax = context('wax', 'Candle warmer lamp', ['用于加热融蜡'], '温度波动大');
  const read = context('read', 'Reading lamp', ['用于阅读照明'], '阅读时眩光');
  assert.equal(action(wax, '验证融蜡温控').outcome, 'supported');
  assert.equal(action(wax, '验证阅读照明眩光').outcome, 'rejected');
  assert.equal(action(read, '验证阅读照明眩光').outcome, 'supported');
  assert.equal(action(read, '验证融蜡温控').outcome, 'rejected');
});
test('A06 unknown non-electric category keeps capacity and access work', () => {
  const c = context('box', '编织收纳筐', ['容量 10 L'], '容量不足，取放不方便');
  assert.equal(c.attributes.wheels.state, 'unknown');
  assert.equal(action(c, '验证容量和取放开口').outcome, 'supported');
  assert.equal(action(c, '增加轮距').outcome, 'needs_check');
});
test('A07 groups are stable, per ASIN, and distinguish wheel counts', () => {
  const all = [context('snow', 'Snow Scooter', ['雪地板底滑行']), context('two', '2 wheel scooter'), context('three', '3 wheel scooter'), context('box', '收纳筐')];
  assert.deepEqual(groupCompatibleProducts(all), groupCompatibleProducts([...all].reverse()));
  assert.equal(groupCompatibleProducts(all).length, 4);
  assert.equal(all[0].attributes.three_wheels.state, 'unknown');
});
test('A08 keyword demand retains negative audience restriction without hardware inference', () => {
  const c = buildProductContext({ scope, asin: 'snow', title: 'Snow Scooter', features: ['不推荐低幼，仅限 8 岁以上'], evidence: [{ id: 'keyword', kind: 'keyword', scope: 'project', role: 'need', text: 'toddler scooter' }] });
  assert.equal(c.attributes.toddler_suitable.state, 'absent');
  assert.equal(c.attributes.wheels.state, 'unknown');
  assert.equal(c.needs[0].text, 'toddler scooter');
  assert.equal(decideProductCandidate(c, { id: 'age', asin: 'snow', kind: 'fact', text: '适合低幼', claim: { attribute: 'toddler_suitable' } }).outcome, 'rejected');
});
test('A09 new configuration allowed despite absence when base structure and need support it', () => {
  const c = context('two', '2 wheel scooter', ['有握把，无可调握把'], '握把高度不舒适');
  const d = decideProductCandidate(c, { id: 'new', asin: 'two', kind: 'proposal', text: '新增可调握持设计', needEvidenceRefs: ['two:need'], conditions: [{ attribute: 'grip' }], addsAttributes: ['adjustable_grip'], validation: ['验证调节锁止与握持舒适度'] });
  assert.equal(c.attributes.adjustable_grip.state, 'absent');
  assert.equal(d.outcome, 'supported');
  assert.equal(d.kind, 'proposal');
});
test('A10 conflicting attributes preserve both refs and only dependent actions need checking', () => {
  const c = context('three', '3 wheel scooter', ['两轮结构']);
  assert.ok(c.conflicts.some((v) => v.attribute === 'three_wheels'));
  const fact = decideProductCandidate(c, { id: 'conflict', asin: 'three', kind: 'fact', text: '三轮', claim: { attribute: 'three_wheels' } });
  assert.equal(fact.outcome, 'needs_check');
  assert.ok(fact.evidenceRefs.length >= 2);
  assert.equal(action(c, '验证连接强度').outcome, 'supported');
});
test('source roles, negation and scope never manufacture hardware', () => {
  const c = buildProductContext({ scope, asin: 'two', title: 'Scooter', evidence: [
    { id: 'wish', kind: 'voc', role: 'need', scope: 'asin', asin: 'two', text: '希望增加三轮' },
    { id: 'foreign', kind: 'attribute', scope: 'asin', asin: 'three', text: 'three wheels' },
    { id: 'other-project', kind: 'attribute', scope: 'asin', asin: 'two', text: 'three wheels', inputScope: { ...scope, projectId: 'other' } },
  ] });
  assert.equal(c.attributes.three_wheels.state, 'unknown');
  assert.deepEqual(c.evidence.map((v) => v.id).sort(), ['two:title', 'wish']);
  const negative = context('two', 'Scooter', ['not three wheels; no wheels']);
  assert.equal(negative.attributes.three_wheels.state, 'absent');
  assert.equal(negative.attributes.wheels.state, 'absent');
});
test('A11 scoped cache includes order-independent ASINs, revision and rules', () => {
  const key = buildProductStructureCacheKey(scope);
  assert.equal(key, buildProductStructureCacheKey({ ...scope, asins: [...scope.asins].reverse() }));
  for (const changed of [{ projectId: 'other' }, { marketplace: 'CA' }, { inputRevision: '2' }, { organizationId: 'other' }, { asins: ['two'] }]) assert.notEqual(key, buildProductStructureCacheKey({ ...scope, ...changed }));
  assert.notEqual(key, buildProductStructureCacheKey(scope, 'other'));
});
test('positive VOC is valid preservation demand and trace contexts retain bounded evidence', () => {
  const c = buildProductContext({ scope, asin: 'two', title: '2 wheel scooter', evidence: [
    { id: 'positive', kind: 'voc', role: 'fact', scope: 'asin', asin: 'two', text: '握持很舒适' },
    { id: 'unused', kind: 'voc', role: 'need', scope: 'asin', asin: 'two', text: '另一个无关问题' },
  ] });
  const d = evaluateTextAction(c, '保留舒适体验并验证改版后的体验', { needEvidenceRefs: ['positive'] });
  assert.equal(d.outcome, 'supported');
  const trace = buildAnalysisRuleTrace([c], [d]);
  assert.ok(trace.contexts?.[0].attributes.two_wheels);
  assert.ok(!trace.contexts?.[0].evidence.some((source) => source.id === 'unused'));
});
test('incompatible action cites opposing source and within-source contradictions remain conflicts', () => {
  const c = context('snow', 'Snow Scooter', ['雪地板底滑行']);
  assert.ok(action(c, '增加轮距').evidenceRefs.includes('snow:feature:0'));
  const conflict = context('two', 'two wheels; three wheels');
  assert.ok(conflict.conflicts.some((entry) => entry.attribute === 'two_wheels'));
});
test('unsupported exact specifications and unrelated structure facts require checking', () => {
  const c = context('two', '2 wheel scooter', [], '稳定性不足');
  assert.equal(action(c, '将轮距设定为 30 cm').outcome, 'needs_check');
  assert.equal(action(c, '将轮距设定为30厘米').outcome, 'needs_check');
  assert.equal(decideProductCandidate(c, { id: 'unsupported-fact', asin: 'two', kind: 'fact', text: '已有蓝牙音响', evidenceRefs: ['two:title'] }).outcome, 'needs_check');
});
test('functional keywords support applicable proposals; audience keywords support verification only', () => {
  const c = buildProductContext({ scope, asin: 'read', title: 'reading lamp', evidence: [
    { id: 'function', kind: 'keyword', scope: 'project', text: 'dimmable reading lamp' },
    { id: 'audience', kind: 'keyword', scope: 'project', text: 'toddler lamp' },
  ] });
  assert.equal(evaluateTextAction(c, '验证阅读照明调光效果', { needEvidenceRefs: ['function'] }).outcome, 'supported');
  assert.equal(evaluateTextAction(c, '核对适龄限制与实际操作尺寸', { needEvidenceRefs: ['audience'], proposalPurpose: 'verify_audience' }).outcome, 'supported');
  assert.notEqual(evaluateTextAction(c, '扩大轮距', { needEvidenceRefs: ['audience'], proposalPurpose: 'verify_audience' }).outcome, 'supported');
});
test('fact fallback cannot quote an affirmative substring out of negative evidence', () => {
  const c = context('box', 'Storage basket', ['No Bluetooth speaker']);
  assert.equal(decideProductCandidate(c, { id: 'negated', asin: 'box', kind: 'fact', text: 'Bluetooth speaker', evidenceRefs: ['box:feature:0'] }).outcome, 'needs_check');
});
test('review: a detected structure does not ground compound facts or reverse polarity', () => {
  const c = context('two', '2 wheel scooter', [], '包装容易破损');
  for (const text of ['该两轮产品已配蓝牙音响', '不是两轮产品']) assert.notEqual(evaluateTextAction(c, text, { kind: 'fact' }).outcome, 'supported');
  assert.equal(decideProductCandidate(c, { id: 'name', asin: 'two', kind: 'fact', text: `商品原名：${c.title}`, evidenceRefs: ['two:title'] }).outcome, 'supported');
  assert.equal(evaluateTextAction(c, '两轮结构', { kind: 'fact' }).outcome, 'supported');
});
test('review: development demand must relate to the hardware action', () => {
  const packaging = context('two', '2 wheel scooter', [], '包装容易破损');
  assert.equal(action(packaging, '改为三轮').outcome, 'needs_check');
  assert.equal(action(packaging, '增加轮距').outcome, 'needs_check');
  assert.equal(decideProductCandidate(packaging, { id: 'direct', asin: 'two', kind: 'proposal', text: '改为三轮', needEvidenceRefs: ['two:need'], validation: ['验证稳定性'] }).outcome, 'needs_check');
  assert.equal(action(packaging, '检查包装易损位置并验证运输保护').outcome, 'supported');
  assert.equal(action(context('two', '2 wheel scooter', [], '转弯时容易倾倒，需要提高稳定性'), '改为三轮并验证转弯稳定性').outcome, 'supported');
});
test('review: incidental package artwork is not wheel demand; actual independent problems remain usable', () => {
  const c = context('two', '2 wheel scooter', [], '包装上印有车轮图案，运输中包装破损');
  assert.equal(action(c, '改为三轮并验证稳定性').outcome, 'needs_check');
  assert.equal(action(c, '增加轮距').outcome, 'needs_check');
  assert.equal(action(c, '检查包装易损位置并验证运输保护').outcome, 'supported');
  const mixed = context('two', '2 wheel scooter', [], '包装印有三轮图案；实际转弯容易倾倒');
  assert.equal(action(mixed, '改为三轮并验证稳定性').outcome, 'supported');
  const broken = context('two', '2 wheel scooter', [], '车轮断裂');
  assert.equal(action(broken, '改为三轮').outcome, 'needs_check');
  assert.equal(action(broken, '验证车轮强度和轴承耐用性').outcome, 'supported');
});
test('review: conjunctions and commas preserve competing structure assertions', () => {
  for (const title of ['three wheels and two wheels', '三轮和两轮', '无轮，三轮结构']) {
    const c = context('two', title);
    assert.ok(c.conflicts.length, title);
    assert.notEqual(evaluateTextAction(c, '三轮结构', { kind: 'fact' }).outcome, 'supported');
  }
});
test('review: trace refuses ambiguous cross-ASIN evidence IDs without selecting a winner', () => {
  const make = (asin: string) => buildProductContext({ scope, asin, title: 'basket', evidence: [{ id: 'need', text: `${asin} 容量不足`, kind: 'voc', scope: 'asin', asin, role: 'need' }] });
  const all = [make('two'), make('three')];
  assert.throws(() => buildAnalysisRuleTrace(all, all.map(c => evaluateTextAction(c, '验证容量', { needEvidenceRefs: ['need'] }))), /ambiguous|collision/i);
});
test('definitions and traces have versioned operator conditions and bounded sources', () => {
  assert.equal(RULE_DEFINITIONS.length, 12);
  for (const d of RULE_DEFINITIONS) {
    assert.equal(d.version, RULE_SET_VERSION);
    assert.ok(d.positiveExample && d.negativeExample && d.conditions.length);
    for (const p of d.conditions) assert.ok(describeRulePredicate(p));
  }
  const c = context('two', '2 wheel scooter');
  const trace = buildAnalysisRuleTrace([c], [action(c, '验证连接强度')]);
  assert.equal(trace.ruleSetVersion, RULE_SET_VERSION);
  assert.equal(trace.sources.length, 1);
  const auditedVersions: Record<string, string> = { 'product-structure/1.0.0': 'fc516ad5', 'product-structure/1.1.0': 'a801f734', 'product-structure/1.1.1': 'e17921b1', 'product-structure/1.1.2': '6f0d902d', 'product-structure/1.1.3': '7c491ea5' };
  assert.equal(ruleDefinitionFingerprint(), auditedVersions[RULE_SET_VERSION], 'Executable or descriptive rule drift requires a reviewed rule version, examples and regression update');
});
