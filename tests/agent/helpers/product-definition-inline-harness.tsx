import React from 'react';
import { createRoot } from 'react-dom/client';
import { LocalProductDefinitionSection } from '../../../app/local-product-definition-section';
import type { FinalProductDefinitionReport } from '../../../app/final-product-definition';
import { buildAnalysisRuleTrace, buildProductContext, decideProductCandidate, type AnalysisInputScope } from '../../../shared/product-structure-rules';
import '../../../app/globals.css';
import '../../../app/warm-theme.css';
import '../../../app/comparison-layout.css';

const asins = ['B0DDX8MYKQ', 'B0F23VR2S4'];
const scope: AnalysisInputScope = { organizationId: 'test', projectId: 'test', marketplace: 'US', asins, inputRevision: 'test' };
const text = '居家装饰用户，期待方便地调节高度。记录了客厅和卧室的日常体验，原始反馈包含多个使用片段。'.repeat(9);
const contexts = asins.map((asin, index) => buildProductContext({ scope, asin, title: 'Candle warmer lamp', evidence: [{ id: `source-${index}`, asin, scope: 'asin', kind: 'voc', text: index ? '其他商品的独立反馈' : text, inputScope: scope }] }));
const decisions = contexts.map((context, index) => decideProductCandidate(context, { id: `candidate-${index}`, asin: asins[index], kind: 'fact', text: index ? '其他商品的独立反馈' : text, sourceObservation: 'audiences', evidenceRefs: [`source-${index}`] }));
decisions[0].matchedConditions.push({ predicate: { op: 'structure' }, description: '实际结构尚未确认', passed: null });
decisions[0].checks = ['核对适龄限制'];
const trace = buildAnalysisRuleTrace(contexts, decisions);
for (let index = 2; index <= 4; index++) {
  trace.sources.push({ id: `source-${index}`, asin: asins[0], scope: 'asin', kind: 'voc', text: `当前商品补充反馈 ${index}`, inputScope: scope });
  trace.decisions[0].evidenceRefs.push(`source-${index}`);
}
trace.decisions[0].evidenceRefs.push('missing-source');
const ids = ['candidate-0'];
const combined = `[${asins[0]}] ${text}；[${asins[1]}] ${text}`;
const report: FinalProductDefinitionReport = {
  meta: { categoryLabel: 'Candle Lamps', productCount: 2, dataMonth: '2026-09', analyzedAt: '2026-09-17', sources: ['测试数据'] }, hasData: true,
  oneLiner: `为【${combined}】提供按实际条件验证的产品。`,
  oneLinerCards: [{ key: 'audience', label: '卖给谁', value: combined, tone: 'audience' }, { key: 'scene', label: '什么场景', value: combined, tone: 'scenario' }, { key: 'pain', label: '解决什么', value: '验证调节便利性', tone: 'pain' }, { key: 'product', label: '做什么产品', value: '融蜡灯', tone: 'product' }],
  rationale: [], opportunity: { grade: 'B', gradeLabel: 'B级', judgment: '待验证', demandBasis: '示例', entryPath: '验证', mainRisks: '待核对', note: '浏览器测试数据' }, crossRows: [],
  definitionRows: [{ dimension: '目标人群', conclusion: combined, vocBasis: combined, keywordBasis: 'candle warmer lamp', action: '核对实际条件', priority: 'P0', pending: '不可从关键词推断适龄', ruleDecisionIds: ids }],
  featureLayers: { mustHave: [{ item: '调节便利性', evidence: '对应商品反馈', ruleDecisionIds: ids }], differentiation: [], optional: [], notInV1: [], p0Avoid: [] },
  keywordGroups: [{ type: '待验证功能词', keywords: 'height adjustable; candle warmer lamp; '.repeat(60), productLink: combined, listingAngle: '验证功能', skuHint: '不承诺配置', ruleDecisionIds: ids }],
  priorityRows: [{ priority: 'P0', direction: '高度调节困难', evidence: combined, businessImpact: '体验', action: '复现问题', acceptance: '确定验收条件', ruleDecisionIds: ids }],
  risks: [], nextValidations: [], dataBoundary: '交互测试，不用于业务判断', ruleTrace: trace,
};
createRoot(document.getElementById('root')!).render(<div style={{ padding: 24, maxWidth: 1540, margin: 'auto' }}><LocalProductDefinitionSection products={[]} sources={{ manualVocByAsin: {}, keywordDemand: null }} savedReport={report} /></div>);
