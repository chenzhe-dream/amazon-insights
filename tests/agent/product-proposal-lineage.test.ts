import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductLaunchAnalysis, type LaunchProductInput } from '../../app/product-launch-analysis';
import { buildFinalProductDefinition } from '../../app/final-product-definition';
import type { ManualAlexaVocNormalizedRecord } from '../../shared/agent-contracts';
import { buildProductContext, buildAnalysisRuleTrace, evaluateTextAction } from '../../shared/product-structure-rules';
import { explainFinalActions } from '../../app/lib/product-structure-analysis';

const wheel: LaunchProductInput = { asin: 'B0WHEEL001', title: 'Three wheel scooter', brand: 'Fixture', price: 40 };
const candle: LaunchProductInput = { asin: 'B0CANDLE01', title: 'Candle warmer lamp', brand: 'Fixture', price: 30 };
function voc(asin: string, unmet: string): ManualAlexaVocNormalizedRecord {
  return { asin, attention: [], positives: ['【性价比】约 60% 提及'], negatives: [], unmet: [unmet], audiences: [], scenarios: [], motives: [], captureStatus: 'dialog', alexaReport: { asin, title: 'Fixture', captureStatus: 'dialog', rating: 4, reviewCount: 30, prompt: 'fixture', overallConclusion: unmet } };
}
function run(products: LaunchProductInput[], needs: Record<string, string>) {
  const analysis = buildProductLaunchAnalysis(products, { manualVocByAsin: Object.fromEntries(products.map(p => [p.asin, voc(p.asin, needs[p.asin])])), keywordDemand: null, analysisScope: { organizationId: 'fixture-org', projectId: 'lineage', marketplace: 'US' } });
  const final = buildFinalProductDefinition({ categoryLabel: analysis.meta.categoryLabel, productCount: products.length, dataMonth: analysis.meta.dataMonth, vocPositioning: analysis.vocPositioning, keyword: analysis.keywordConclusions, hasVocData: true });
  return { analysis, final };
}

test('mixed final features keep rear-wheel need on its original ASIN and preserve its useful action', () => {
  const needs = { [wheel.asin]: '希望从根本上解决后轮融化问题', [candle.asin]: '希望增强散香能力' };
  for (const products of [[wheel, candle], [candle, wheel]]) {
    const { final } = run(products, needs);
    const rows = Object.values(final.featureLayers).flat().filter(row => /后轮/.test(row.item));
    assert.ok(rows.length, 'wheel improvement must remain visible');
    for (const row of rows) {
      const linked = final.ruleTrace!.decisions.filter(d => row.ruleDecisionIds?.includes(d.candidateId));
      assert.ok(linked.some(d => d.asin === wheel.asin && d.outcome === 'supported'));
      assert.ok(linked.every(d => d.asin === wheel.asin), 'unrelated candle must not inherit this candidate');
      assert.ok(linked.every(d => d.evidenceRefs.every(ref => !ref.startsWith(candle.asin))));
    }
  }
});

test('same-category non-hardware needs do not spread through final feature aggregation', () => {
  const other = { ...candle, asin: 'B0CANDLE02' };
  const { final } = run([candle, other], { [candle.asin]: '希望增加配件购买渠道', [other.asin]: '希望增强散香能力' });
  const rows = Object.values(final.featureLayers).flat().filter(row => /散香/.test(row.item));
  assert.ok(rows.length);
  for (const row of rows) {
    const linked = final.ruleTrace!.decisions.filter(d => row.ruleDecisionIds?.includes(d.candidateId));
    assert.ok(linked.some(d => d.asin === other.asin && d.outcome === 'supported'));
    assert.ok(linked.every(d => d.asin === other.asin));
  }
});

for (const need of ['希望实现亮度和温度分离控制', '希望提高短期故障控制']) {
  test(`control semantics: ${need} retains the actual problem`, () => {
    const { analysis } = run([candle], { [candle.asin]: need });
    const decisions = analysis.ruleTrace!.decisions.filter(d => d.candidateId.startsWith('voc-unmet:'));
    assert.ok(decisions.some(d => d.outcome === 'supported'));
    assert.ok(decisions.every(d => !/握持|适龄/.test(d.text)));
  });
}

test('candle dimming is a useful proposal without requiring reading suitability', () => {
  const { analysis } = run([candle], { [candle.asin]: '希望支持无级调光或提供更多亮度档位' });
  const decisions = analysis.ruleTrace!.decisions.filter(d => d.candidateId.startsWith('voc-unmet:'));
  assert.ok(decisions.some(d => d.outcome === 'supported' && /调光|亮度/.test(d.text)));
  assert.ok(decisions.every(d => !d.matchedConditions.some(c => c.predicate.attribute === 'reading_illumination')));
});

test('canonical theme labels keep the specific original issue and useful action', () => {
  const product = { ...candle, asin: 'B0DETAIL01' };
  const record = voc(product.asin, '希望改善质量');
  record.negatives = ['【耐久性差】约 40% 提及：灯泡经常烧坏，几周后停止工作'];
  record.positives = ['【定时功能】约 60% 提及：可按设定时间关闭'];
  const analysis = buildProductLaunchAnalysis([product], { manualVocByAsin: { [product.asin]: record }, keywordDemand: null });
  const negative = analysis.ruleTrace!.decisions.filter(d => d.candidateId.startsWith('voc-negative:'));
  const positive = analysis.ruleTrace!.decisions.filter(d => d.candidateId.startsWith('voc-positive:'));
  assert.ok(negative.some(d => d.outcome === 'supported' && /耐久性差|灯泡/.test(d.text)));
  assert.ok(positive.some(d => d.outcome === 'supported' && /定时/.test(d.text)));
});

test('a pending or rejected explanation cannot be reclassified as a supported new proposal', () => {
  const context = buildProductContext({ asin: 'snow', title: 'Snow sled, no wheels', scope: { organizationId: 'org', projectId: 'pending', marketplace: 'US', asins: ['snow'], inputRevision: '1' }, evidence: [{ id: 'need', text: '稳定性不足', kind: 'voc', scope: 'asin', asin: 'snow', role: 'need' }] });
  const original = evaluateTextAction(context, '改进轮距并验证稳定性', { id: 'original', needEvidenceRefs: ['need'] });
  assert.equal(original.outcome, 'rejected');
  const base = buildAnalysisRuleTrace([context], [original]);
  const row = { dimension: '开发优先级-0', action: `核对「稳定性」：${original.summary}`, ruleDecisionIds: [original.candidateId] };
  const result = explainFinalActions(base, undefined, [row])!;
  const linked = result.decisions.filter(d => row.ruleDecisionIds.includes(d.candidateId));
  assert.ok(linked.length);
  assert.ok(linked.every(d => d.outcome !== 'supported'));
  assert.match(row.action, /待核对/);
});
