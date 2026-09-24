import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExportModuleContext, ExportModuleRead } from '../../app/project-export/export-module-context';
import { readVocExportSection } from '../../app/project-export/voc-export-section';
import { readDefinitionExportSection } from '../../app/project-export/definition-export-section';
import { readChecklistExportSection } from '../../app/project-export/checklist-export-section';
import { buildCurrentPageAnalysis, readLocalRuleReportsForExport, readManualVocRecords, readRunReportsForExport } from '../../app/project-export/read-voc-definition-export';
import { buildFinalProductDefinition } from '../../app/final-product-definition';
import type { ManualAlexaVocRecord } from '../../shared/agent-contracts';

const asin = 'B012345678';
const context: ExportModuleContext = {
  projectId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222',
  marketplace: 'US', asins: [asin], sourceAsins: [asin], currentRunId: null, version: null, capturedAt: '2026-09-24T00:00:00.000Z',
};
const response = (body: unknown, status = 200) => Response.json(body, { status });

function reader(bodies: Record<string, unknown>, paths: string[] = []): ExportModuleRead {
  return async path => { paths.push(path); const key = path.split('?')[0]; return response(bodies[key] ?? { error: 'unexpected path' }, key in bodies ? 200 : 404); };
}

test('three modules distinguish an unpublished or unsaved result from a transport error', async () => {
  const paths: string[] = [];
  const read = reader({ '/api/alexa-voc': { records: [] }, '/api/local-rule-reports': { reports: [] } }, paths);
  const [voc, definition, checklist] = await Promise.all([
    readVocExportSection(context, read), readDefinitionExportSection(context, read), readChecklistExportSection(context, read),
  ]);
  assert.equal(voc.status, 'missing');
  assert.equal(definition.status, 'missing');
  assert.equal(checklist.status, 'missing');
  assert(paths.every(path => path.startsWith('/api/alexa-voc?') || path.startsWith('/api/local-rule-reports?')));
  assert(paths.every(path => path.includes(`projectId=${context.projectId}`)));
  await assert.rejects(readManualVocRecords(context, reader({})), /读取失败/);
});

test('VOC preserves every saved seven-dimension line and rejects changing revisions', async () => {
  const normalized = {
    asin, attention: ['关注甲', '关注乙'], positives: ['【满意】暂无数据：原文好评'], negatives: ['差评甲'], unmet: ['未满足甲'],
    audiences: ['家长｜需要安全'], scenarios: ['公园｜周末'], motives: ['礼物｜★★★★★｜生日'], captureStatus: 'dialog',
    alexaReport: { title: '原始标题', asin, rating: 4.2, reviewCount: 319, prompt: '七问原文', overallConclusion: '完整总体结论' },
  };
  const base = { asin, marketplace: 'US', revision: '1', contentHash: 'a'.repeat(64), normalizedRecord: normalized,
    source: 'postgres', generation: null, capturedAt: '2026-09-24T00:00:00.000Z' };
  const read = reader({ '/api/alexa-voc': { records: [base] }, '/api/local-rule-reports': { reports: [] } });
  const section = await readVocExportSection(context, read);
  assert.equal(section.status, 'ready');
  const content = JSON.stringify(section.blocks);
  for (const line of ['关注甲', '关注乙', '原文好评', '完整总体结论', '礼物｜★★★★★｜生日']) assert(content.includes(line));
  let reads = 0;
  await assert.rejects(readManualVocRecords(context, async () => response({ records: [{ ...base, revision: String(++reads) }] })), /变化/);
});

test('local saved report must match organization, project, marketplace and exact ASIN set', async () => {
  const report = { schemaVersion: 'local-rule-report/v1', id: 'r1', createdAt: context.capturedAt,
    inputScope: { organizationId: 'another-org', projectId: context.projectId, marketplace: 'US', asins: [asin] },
    products: [{ asin }], analysis: {}, finalDefinition: {} };
  await assert.rejects(readDefinitionExportSection(context, reader({ '/api/local-rule-reports': { reports: [report] }, '/api/alexa-voc': { records: [] } })), /来源范围不匹配/);
});

test('a historical saved checklist cannot replace missing current page inputs', async () => {
  const report = { schemaVersion: 'local-rule-report/v1', id: 'r1', createdAt: context.capturedAt,
    inputScope: { organizationId: context.organizationId, projectId: context.projectId, marketplace: 'US', asins: [asin] },
    products: [{ asin }], finalDefinition: {}, analysis: {
      checklistMeta: { version: 'V1.0', verticalLabel: '灯具', policy: '待核验', totalItems: 2 },
      checklistResearch: { asinList: asin, categoryNode: '照明', topNegative: '散热问题' },
      checklist: [{ section: '十', id: 'ten', title: '终审', description: '最终核验', items: [],
        entries: [{ id: 'saved', label: '系统来源', source: 'auto', autoValue: '已保存证据' }, { id: 'manual', label: '人工核验', source: 'manual' }],
        structuredTable: { headers: ['项目', '结果'], rows: [[{ key: 'name', source: 'auto', text: '系统成本' }, { key: 'amount', source: 'manual', text: '□' }]] } }],
    } };
  const paths: string[] = [];
  const section = await readChecklistExportSection(context, reader({ '/api/local-rule-reports': { reports: [report] }, '/api/alexa-voc': { records: [] } }, paths));
  assert.equal(section.status, 'missing');
  const content = JSON.stringify(section.blocks);
  assert(!content.includes('散热问题'));
  assert(!paths.some(path => path.startsWith('/api/local-rule-reports')));
});

test('checklist and definition replay the existing page rule output from scoped saved inputs', async () => {
  const normalized = { asin, attention: ['安全'], positives: ['【稳定】表现好'], negatives: ['【连接】松动'], unmet: ['更稳固'],
    audiences: ['家长｜给孩子购买'], scenarios: ['公园｜骑行'], motives: ['送礼｜★★★★★｜生日'], captureStatus: 'dialog',
    alexaReport: { title: '报告', asin, rating: 4.4, reviewCount: 100, prompt: '七问', overallConclusion: '安全与稳定' } };
  const manual = { asin, marketplace: 'US', revision: '1', contentHash: 'a'.repeat(64), normalizedRecord: normalized,
    source: 'postgres', generation: null, capturedAt: context.capturedAt };
  const liveContext = { ...context, version: {
    catalog: [{ asin, brand: '示例品牌', title: '儿童滑板车', price: 39.99, sales: 500, subRankCategory: 'Scooters', productFamily: 'scooter' }],
    stageOutputs: {},
  } as unknown as NonNullable<ExportModuleContext['version']> };
  const read = reader({ '/api/local-rule-reports': { reports: [] }, '/api/alexa-voc': { records: [manual] } });
  const checklist = await readChecklistExportSection(liveContext, read);
  const definition = await readDefinitionExportSection(liveContext, read);
  assert.equal(checklist.status, 'ready');
  assert.equal(definition.status, 'ready');
  assert(JSON.stringify(checklist.blocks).includes('未保存编辑'));
  assert(!JSON.stringify(checklist.blocks).includes('已保存系统值'));
  assert(JSON.stringify(definition.blocks).includes('最终产品定义'));
});

test('one preparation shares validated VOC, local reports and run reports across three modules', async () => {
  const runId = '33333333-3333-4333-8333-333333333333';
  const shared = { ...context, currentRunId: runId, sharedReads: new Map<string, Promise<unknown>>() };
  const counts = new Map<string, number>();
  const read: ExportModuleRead = async path => {
    const key = path.split('?')[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key === '/api/alexa-voc') return response({ records: [] });
    if (key === '/api/local-rule-reports') return response({ reports: [] });
    if (key === `/v1/runs/${runId}`) return response({ run: { id: runId, projectId: context.projectId, mode: 'existing-data',
      status: 'succeeded', createdBy: context.organizationId, dataCutoffAt: context.capturedAt,
      createdAt: context.capturedAt, updatedAt: context.capturedAt }, stages: [] });
    if (key === `/v1/runs/${runId}/reports`) return response({ reports: [] });
    return response({ error: 'unexpected' }, 404);
  };
  await Promise.all([readVocExportSection(shared, read), readDefinitionExportSection(shared, read), readChecklistExportSection(shared, read)]);
  assert.equal(counts.get('/api/alexa-voc'), 2);
  assert.equal(counts.get('/api/local-rule-reports'), 2);
  assert.equal(counts.get(`/v1/runs/${runId}`), 1);
  assert.equal(counts.get(`/v1/runs/${runId}/reports`), 2);
});

test('shared mutable read still rejects a changing revision for every section', async () => {
  const shared = { ...context, sharedReads: new Map<string, Promise<unknown>>() };
  let vocReads = 0;
  const normalized = { asin, attention: ['关注'], positives: ['好评'], negatives: ['差评'], unmet: ['缺口'],
    audiences: ['人群'], scenarios: ['场景'], motives: ['动机'], captureStatus: 'dialog',
    alexaReport: { title: '完整报告', asin, rating: 4, reviewCount: 20, prompt: '七问', overallConclusion: '原文' } };
  const read: ExportModuleRead = async path => {
    if (path.startsWith('/api/local-rule-reports?')) return response({ reports: [] });
    if (path.startsWith('/api/alexa-voc?')) {
      vocReads++;
      return response({ records: [{ asin, marketplace: 'US', revision: String(vocReads), contentHash: 'a'.repeat(64),
        normalizedRecord: normalized, source: 'postgres', generation: null, capturedAt: context.capturedAt }] });
    }
    return response({}, 404);
  };
  const results = await Promise.allSettled([readVocExportSection(shared, read), readDefinitionExportSection(shared, read), readChecklistExportSection(shared, read)]);
  assert.equal(vocReads, 2);
  assert(results.every(result => result.status === 'rejected'));
  assert(results.every(result => result.status === 'rejected' && /变化/.test(String(result.reason))));
});

test('page fallback rejects a nested review record from a different ASIN', () => {
  const scoped = { ...context, version: {
    catalog: [{ asin, brand: '品牌', title: '商品' }],
    stageOutputs: { reviews: { data: { analysisByAsin: { [asin]: { asin: 'B000000000', marketplace: 'US' } } } } },
  } as unknown as NonNullable<ExportModuleContext['version']> };
  assert.throws(() => buildCurrentPageAnalysis(scoped, []), /来源 ASIN 或站点不匹配/);
});

test('review candidates alone do not create a checklist or definition that the page would not show', async () => {
  const scoped = { ...context, version: {
    catalog: [{ asin, brand: '品牌', title: '商品' }],
    stageOutputs: { reviews: { data: { analysisByAsin: { [asin]: { asin, marketplace: 'US', status: 'ready', blocks: [] } } } } },
  } as unknown as NonNullable<ExportModuleContext['version']> };
  const read = reader({ '/api/local-rule-reports': { reports: [] }, '/api/alexa-voc': { records: [] } });
  const [checklist, definition] = await Promise.all([readChecklistExportSection(scoped, read), readDefinitionExportSection(scoped, read)]);
  assert.equal(checklist.status, 'missing');
  assert.equal(definition.status, 'missing');
});

test('saved report nested evidence must match project scope and run fingerprint', async () => {
  const runId = '33333333-3333-4333-8333-333333333333';
  const selection = { schemaVersion: 'voc-evidence/v1', organizationId: context.organizationId, projectId: context.projectId,
    baseSyncRunId: '44444444-4444-4444-8444-444444444444', marketplace: 'US', selectedAsins: [asin],
    sourcePolicy: 'manual-only', fingerprint: 'a'.repeat(64), sourceMode: 'manual',
    coverage: [{ asin, primary: 'manual', manualDimensions: [], reviewDimensions: [], missingDimensions: [],
      manual: null, review: null }], keywords: { state: 'missing', source: null } };
  const report = { schemaVersion: '1.0.0', id: '55555555-5555-4555-8555-555555555555', runId,
    agentRunId: '66666666-6666-4666-8666-666666666666', version: 1, stage: 'product-definition', status: 'complete',
    skill: { id: 'define-amazon-product-from-voc-keywords', version: '1.0.0', contentHash: 'b'.repeat(64) },
    snapshotIds: ['77777777-7777-4777-8777-777777777777'], model: { provider: 'openai', model: 'saved' },
    dataCutoffAt: context.capturedAt, evidence: [{ id: 'source', type: 'report', sourceId: 'original', capturedAt: context.capturedAt }],
    result: { evidenceSelection: { ...selection, fingerprint: 'c'.repeat(64) }, identity: { inputFingerprint: 'c'.repeat(64) } },
    createdAt: context.capturedAt };
  const scoped = { ...context, currentRunId: runId };
  const read = reader({ [`/v1/runs/${runId}`]: { run: { id: runId, projectId: context.projectId, mode: 'existing-data',
    status: 'succeeded', createdBy: context.organizationId, dataCutoffAt: context.capturedAt,
    createdAt: context.capturedAt, updatedAt: context.capturedAt }, stages: [], evidenceSelection: selection },
    [`/v1/runs/${runId}/reports`]: { reports: [report] } });
  await assert.rejects(readRunReportsForExport(scoped, read), /证据指纹与运行不匹配/);
  const wrongScope = reader({ [`/v1/runs/${runId}`]: { run: { id: runId, projectId: context.projectId, mode: 'existing-data',
    status: 'succeeded', createdBy: context.organizationId, dataCutoffAt: context.capturedAt,
    createdAt: context.capturedAt, updatedAt: context.capturedAt }, stages: [], evidenceSelection: selection },
    [`/v1/runs/${runId}/reports`]: { reports: [{ ...report, result: { evidenceSelection: { ...selection, organizationId: '88888888-8888-4888-8888-888888888888' } } }] } });
  await assert.rejects(readRunReportsForExport(scoped, wrongScope), /证据范围不匹配/);
});

test('local report rejects out-of-scope VOC bindings and nested rule trace references', async () => {
  const inputScope = { organizationId: context.organizationId, projectId: context.projectId, marketplace: 'US', asins: [asin], inputRevision: 'rev' };
  const trace = { ruleSetVersion: 'v1', ruleDefinitions: [], inputScope, decisions: [{ asin, inputScope }],
    sources: [{ id: 's1', scope: 'asin', asin, kind: 'voc', text: '来源' }] };
  const base = { schemaVersion: 'local-rule-report/v1', id: 'r1', createdAt: context.capturedAt,
    inputScope, products: [{ asin }], analysis: { ruleTrace: trace }, finalDefinition: { ruleTrace: trace },
    sourceBindings: { manualVoc: [{ asin, revision: '1', contentHash: 'a'.repeat(64) }], stages: [] } };
  const other = 'B000000000';
  for (const altered of [
    { ...base, sourceBindings: { ...base.sourceBindings, manualVoc: [{ asin: other }] } },
    { ...base, analysis: { ruleTrace: { ...trace, decisions: [{ asin: other, inputScope }] } } },
    { ...base, finalDefinition: { ruleTrace: { ...trace, sources: [{ id: 's2', scope: 'asin', asin: other }] } } },
    { ...base, finalDefinition: { ruleTrace: { ...trace, inputScope: { ...inputScope, projectId: 'other' } } } },
  ]) {
    await assert.rejects(readLocalRuleReportsForExport(context, reader({ '/api/local-rule-reports': { reports: [altered] } })), /不匹配/);
  }
});

test('current page definition stays first while older saved rule results remain labeled history', async () => {
  const normalized = { asin, attention: ['当前安全'], positives: ['当前好评'], negatives: ['当前差评'], unmet: ['当前需求'],
    audiences: ['家长'], scenarios: ['公园'], motives: ['送礼'], captureStatus: 'dialog',
    alexaReport: { title: '当前报告', asin, rating: 4.5, reviewCount: 100, prompt: '七问', overallConclusion: '当前结论' } };
  const manual = { asin, marketplace: 'US', revision: '2', contentHash: 'a'.repeat(64), normalizedRecord: normalized,
    source: 'postgres', generation: null, capturedAt: context.capturedAt } as ManualAlexaVocRecord;
  const version = { catalog: [{ asin, brand: '品牌', title: '当前商品', price: 29.99 }], stageOutputs: {} } as unknown as NonNullable<ExportModuleContext['version']>;
  const liveContext = { ...context, version };
  const page = buildCurrentPageAnalysis(liveContext, [manual]);
  assert(page);
  const final = buildFinalProductDefinition({ categoryLabel: page.meta.categoryLabel, productCount: page.meta.productCount,
    dataMonth: page.meta.dataMonth, vocPositioning: page.vocPositioning, keyword: page.keywordConclusions,
    priceBand: page.productDefinition.targetPrice, hasVocData: true });
  const local = { schemaVersion: 'local-rule-report/v1', id: 'old-report', createdAt: context.capturedAt,
    inputScope: page.ruleTrace!.inputScope, products: [{ asin }], analysis: { ...page, checklist: [{ section: '十', title: '旧清单内容', id: 'old', items: [] }] },
    finalDefinition: { ...final, oneLiner: '历史旧产品定位' } };
  const read = reader({ '/api/local-rule-reports': { reports: [local] }, '/api/alexa-voc': { records: [manual] } });
  const [definition, checklist, voc] = await Promise.all([
    readDefinitionExportSection(liveContext, read), readChecklistExportSection(liveContext, read), readVocExportSection(liveContext, read),
  ]);
  const defText = JSON.stringify(definition.blocks);
  assert(defText.indexOf('当前页面本地规则产品定义') < defText.indexOf('历史已保存规则结果'));
  assert(defText.includes('历史旧产品定位'));
  const checklistText = JSON.stringify(checklist.blocks);
  assert(!checklistText.includes('旧清单内容'));
  assert(!checklistText.includes('已保存系统值'));
  const vocText = JSON.stringify(voc.blocks);
  assert(vocText.indexOf('当前页面本地规则 VOC 结论') < vocText.indexOf('历史已保存本地规则 VOC 结果'));
});
