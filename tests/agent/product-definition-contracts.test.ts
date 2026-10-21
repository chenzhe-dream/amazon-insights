import { PRODUCT_VALIDATION_RULES, productDefinitionRepairGuidance } from '../../shared/product-validation-rules';
import { freezeSafeValidationIssues } from '../../server/runtime/safe-validation-issues';
import { summarizeZodValidationIssues } from '../../server/runtime/safe-validation-issues';
import { createProductDefinitionModelOutputContract, createProductDefinitionModelOutputSchema } from '../../server/services/product-definition-execution-service';
import { createStructuredResponseFormat } from '../../server/runtime/structured-response-format';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  ProductDefinitionInputSchema,
  canonicalizeProductDefinitionOutput,
  createProductDefinitionOutputSchema,
  extractVocPositioningProjection,
  assertProductDefinitionCapabilityLanguage,
} from "../../server/domain/product/product-definition-contracts";

test('US captured commercial unknowns remain valid without implying profitability', () => {
  const input = evidenceScopedInput('manual');
  const base = canonicalizeProductDefinitionOutput(validOutput(input), input) as ReturnType<typeof validOutput>;
  for (const conclusion of [
    'balance board近30天搜索量120,787、wobble board 22,373，搜索需求存在；但购买率、竞争和价格缺失，不能据此判断销量或利润。',
    '价格档位无法判断；需竞品价格带、成本、平台费用和毛利验证，当前不设具体售价。',
    '补齐竞品价格带、成本、费用和毛利模型后再定档。',
    '完成BOM、物流、平台费、退货和毛利测算后再确定入门/中端价格档。',
    '现有证据无法判断盈利能力。',
    '利润仍需验证。',
    'Profitability cannot be determined from the available evidence.',
    'Profit margin requires validation.',
  ]) {
    const result = {...base, finalDefinition: [{...base.finalDefinition[0], conclusion}]};
    assert.doesNotThrow(() => assertProductDefinitionCapabilityLanguage(result), conclusion);
    assert.equal(createProductDefinitionOutputSchema(input).safeParse(result).success, true, conclusion);
  }
});

test('commercial disclaimers do not hide unsupported claims or approval bypasses', () => {
  for (const conclusion of [
    '利润率高', '预计毛利30%', 'ROI 80%', 'profit margin is attractive', '完成利润',
    '完成高毛利测算后再定价', '完成毛利30%测算后再定价',
    '完成利润高和毛利测算后再定价', '完成BOM与毛利测算后再保证ROI80%',
    '利润仍需验证，但预计毛利30%', '不能判断利润；本产品盈利能力强',
    '不能判断利润但盈利能力很强', '利润率30%仍需验证',
    '公司已批准立项', '无需成本验证', '当前无需合规验证即可销售', '无需成本、专利，验证就能上市',
    'Profitability cannot be determined, but ROI is 80%',
  ]) assert.throws(() => assertProductDefinitionCapabilityLanguage({finalDefinition:[{conclusion}]}), /commercial capability boundary/i, conclusion);
});

test('commercial validation reports the real field path without disclosing its text', () => {
  const input = evidenceScopedInput('manual');
  const base = canonicalizeProductDefinitionOutput(validOutput(input), input) as ReturnType<typeof validOutput>;
  const parsed = createProductDefinitionOutputSchema(input).safeParse({...base, priorities:[{...base.priorities[0], acceptance:'PRIVATE_SENTINEL ROI 80%'}]});
  assert.equal(parsed.success, false); if (parsed.success) return;
  const issues = summarizeZodValidationIssues(parsed.error, createStructuredResponseFormat(createProductDefinitionModelOutputSchema(input), 'Product'));
  assert.deepEqual(issues.filter(i => i.ruleId === 'product-commercial-capability-language').map(i => i.path), [['priorities',0,'acceptance']]);
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_SENTINEL|80%/);
});
import {
  SCOOTER_ASINS,
  realVocFacts,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

test("projects both legacy VOC reports and combined Amazon insight reports", () => {
  const projection = validVocPositioningOutput(
    realVocFacts(SCOOTER_ASINS, randomUUID(), randomUUID()),
  );
  assert.deepEqual(extractVocPositioningProjection(projection), projection);
  assert.deepEqual(
    extractVocPositioningProjection({
      schemaVersion: "1.0.0",
      kind: "amazon-voc-insight-result",
      insight: {},
      positioningProjection: projection,
    }),
    projection,
  );
});

test("new evidence-scoped inputs require matching output identity and preserve nullable pending grade", () => {
  const input = evidenceScopedInput("manual");
  const candidate = canonicalizeProductDefinitionOutput(validOutput(input), input) as Record<string, unknown>;
  const parsed = createProductDefinitionOutputSchema(input).parse(candidate);
  assert.equal(parsed.identity.inputFingerprint, input.evidenceSelection?.fingerprint);
  assert.deepEqual(parsed.evidenceSelection, input.evidenceSelection);

  const pending = {
    ...candidate,
    opportunity: { grade: null, pendingReason: "证据不足，等待验证", scope: "demand-and-product-definition-opportunity", projectApproval: "not-approved" },
  };
  assert.equal(createProductDefinitionOutputSchema(input).parse(pending).opportunity.grade, null);
  assert.throws(() => createProductDefinitionOutputSchema(input).parse({
    ...pending,
    opportunity: { ...(pending.opportunity as object), pendingReason: "" },
  }));
});

test("review fallback cannot produce a final A opportunity grade", () => {
  const input = evidenceScopedInput("review-fallback");
  const candidate = canonicalizeProductDefinitionOutput(validOutput(input), input);
  assert.throws(() => createProductDefinitionOutputSchema(input).parse(candidate), /fallback|grade/i);
});

test("evidence matrix and final definition enforce conditional evidence semantics", () => {
  const input = evidenceScopedInput("manual");
  const base = canonicalizeProductDefinitionOutput(validOutput(input), input) as ReturnType<typeof validOutput>;
  const vocOnly = {
    ...base,
    opportunity: { ...base.opportunity, grade: "B" as const },
    evidenceMatrix: [{ ...base.evidenceMatrix[0], judgment: "voc-only" as const, keywordGroupId: null, keywordEvidenceIds: [] }],
    finalDefinition: [{ ...base.finalDefinition[0], validationStatus: "requires-validation" as const, keywordEvidenceIds: [] }],
  };
  assert.equal(createProductDefinitionOutputSchema(input).safeParse(vocOnly).success, true);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...vocOnly,
    evidenceMatrix: [{ ...vocOnly.evidenceMatrix[0], judgment: "dual-validation", keywordGroupId: null }],
  }).success, false);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...vocOnly,
    finalDefinition: [{ ...vocOnly.finalDefinition[0], validationStatus: "supported" }],
  }).success, false);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...vocOnly,
    evidenceMatrix: [{ ...vocOnly.evidenceMatrix[0], vocEvidenceIds: [], keywordEvidenceIds: [] }],
  }).success, false);
});

test("configuration and priority evidence must belong to trusted VOC or keyword inputs", () => {
  const input = evidenceScopedInput("manual");
  const base = canonicalizeProductDefinitionOutput(validOutput(input), input) as ReturnType<typeof validOutput>;
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...base,
    configurationLayers: { ...base.configurationLayers, mustHave: [{ item: "伪造功能", evidenceIds: ["invented"] }] },
  }).success, false);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...base,
    priorities: [{ ...base.priorities[0], evidenceIds: ["invented"] }],
  }).success, false);
});

function evidenceScopedInput(sourceMode: "manual" | "review-fallback") {
  const snapshotId = randomUUID();
  const runId = randomUUID();
  const voc = validVocPositioningOutput(realVocFacts(SCOOTER_ASINS, snapshotId, runId));
  const vocResult = { ...voc } as Partial<typeof voc>;
  delete vocResult.identity;
  const fingerprint = "a".repeat(64);
  return ProductDefinitionInputSchema.parse({
    schemaVersion: "1.0.0", kind: "amazon-product-definition-input", marketplace: "US",
    asins: SCOOTER_ASINS, dataCutoffAt: "2026-08-15T23:59:59.999Z",
    evidenceSelection: {
      schemaVersion: "voc-evidence/v1", organizationId: randomUUID(), projectId: randomUUID(), baseSyncRunId: randomUUID(),
      marketplace: "US", selectedAsins: SCOOTER_ASINS, sourcePolicy: sourceMode === "manual" ? "manual-only" : "manual-with-review-fallback",
      fingerprint, sourceMode, coverage: SCOOTER_ASINS.map(asin => ({ asin, primary: sourceMode === "manual" ? "manual" : "review", manualDimensions: [], reviewDimensions: [], missingDimensions: [], manual: null, review: null })),
      keywords: { state: "ready", source: null },
    },
    voc: { reportId: randomUUID(), version: 1, snapshotIds: [snapshotId], result: vocResult },
    keywords: { snapshotId: randomUUID(), contentHash: "b".repeat(64), groups: [{ id: "group-1", label: "group", keywords: ["scooter"], demand: "high", trend: "stable", seasonality: "unknown", evidenceIds: ["keyword-1"] }], evidence: [{ id: "keyword-1", sourceId: "source", capturedAt: "2026-08-15T23:59:59.999Z", searchVolume: 100, purchaseRate: null }] },
    commercialData: { cost: "missing", profitability: "missing", patent: "missing", compliance: "missing", supplyChain: "missing" },
  });
}

function validOutput(input: ReturnType<typeof evidenceScopedInput>) {
  const theme = input.voc.result.themeJudgments[0]!;
  return {
    schemaVersion: "1.0.0" as const, kind: "amazon-product-definition" as const, status: "complete" as const,
    identity: { vocReportId: input.voc.reportId, vocReportVersion: input.voc.version, keywordSnapshotId: input.keywords.snapshotId, keywordContentHash: input.keywords.contentHash, dataCutoffAt: input.dataCutoffAt },
    opportunity: { grade: "A" as const, scope: "demand-and-product-definition-opportunity" as const, projectApproval: "not-approved" as const },
    evidenceMatrix: [{ themeKey: theme.themeKey, keywordGroupId: "group-1", vocEvidenceIds: theme.evidenceIds, keywordEvidenceIds: ["keyword-1"], judgment: "dual-validation" as const, productRole: "core-foundation" as const, priority: theme.priority }],
    finalDefinition: [{ dimension: "product-form" as const, conclusion: "基于双侧证据定义产品", vocEvidenceIds: theme.evidenceIds, keywordEvidenceIds: ["keyword-1"], action: "include" as const, priority: theme.priority, validationStatus: "supported" as const }],
    configurationLayers: { mustHave: [{ item: "核心功能", evidenceIds: theme.evidenceIds }], differentiation: [], optional: [], notInV1: [], p0Avoid: [] },
    keywordLanding: [{ groupId: "group-1", role: "core-term" as const, productLink: "产品", listingAngle: "卖点", skuHint: "sku", evidenceIds: ["keyword-1"] }],
    priorities: [{ priority: "P0" as const, direction: "核心方向", evidenceIds: theme.evidenceIds, action: "include" as const, acceptance: "验收" }],
    risks: ["cost", "profitability", "patent", "compliance", "supply-chain"].map(area => ({ area, status: "requires-validation" as const, nextStep: "验证" })),
    commercialValidation: { cost: "requires-validation" as const, profitability: "requires-validation" as const, patent: "requires-validation" as const, compliance: "requires-validation" as const, supplyChain: "requires-validation" as const },
    dataBoundary: "当前最终产品定义由VOC与关键词需求交叉推导。关键词数据反映搜索需求和市场入口，VOC反映使用体验与需求缺口；机会等级仅代表需求与产品定义机会，不得视为完整立项批准。完整立项仍需验证竞争、成本利润、专利合规、MOQ、供应链和现金投入。" as const,
  };
}

test('product wire schema freezes evidence and reference sets with a stable digest', () => {
 const input=evidenceScopedInput('manual'),schema=createProductDefinitionModelOutputSchema(input),base=validOutput(input);
 const wire={...base,evidenceSelection:null,identity:{...base.identity,inputFingerprint:null},opportunity:{...base.opportunity,pendingReason:null}};
 assert.equal(schema.safeParse(wire).success,true);
 for(const field of ['themeKey','keywordGroupId','vocEvidenceIds','keywordEvidenceIds'] as const){
  const row={...wire.evidenceMatrix[0],[field]:field.endsWith('Ids')?['invented']:'invented'};
  assert.equal(schema.safeParse({...wire,evidenceMatrix:[row]}).success,false);
 }
 assert.equal(schema.safeParse({...wire,finalDefinition:[{...wire.finalDefinition[0],keywordEvidenceIds:['invented']}]}).success,false);
 assert.equal(schema.safeParse({...wire,keywordLanding:[{...wire.keywordLanding[0],groupId:'invented'}]}).success,false);
 assert.equal(schema.safeParse({...wire,keywordLanding:[{...wire.keywordLanding[0],evidenceIds:['invented']}]}).success,false);
 for(const layer of Object.keys(wire.configurationLayers))assert.equal(schema.safeParse({...wire,configurationLayers:{...wire.configurationLayers,[layer]:[{item:'x',evidenceIds:['invented']}]}}).success,false);
 assert.equal(schema.safeParse({...wire,priorities:[{...wire.priorities[0],evidenceIds:['invented']}]}).success,false);
 const a=createStructuredResponseFormat(schema,'ProductFrozen');
 const reverse=structuredClone(input);reverse.voc.result.themeJudgments.reverse();reverse.keywords.evidence.reverse();reverse.keywords.groups.reverse();
 assert.equal(a.digest,createStructuredResponseFormat(createProductDefinitionModelOutputSchema(reverse),'ProductFrozen').digest);
 const serialized=JSON.stringify(a.format.schema);assert.match(serialized,/keyword-1/);assert.match(serialized,/group-1/);assert.ok(serialized.includes(input.voc.result.themeJudgments[0].evidenceIds[0]));
});

test('product wire empty allowed sets do not invent references or relax required evidence',()=>{
 const input=evidenceScopedInput('manual');input.keywords.groups=[];input.keywords.evidence=[];
 const schema=createProductDefinitionModelOutputSchema(input),s=schema.shape;
 assert.equal(s.evidenceMatrix.element.options[0].shape.keywordEvidenceIds.safeParse([]).success,true);
 assert.equal(s.evidenceMatrix.element.options[0].shape.keywordEvidenceIds.safeParse(['invented']).success,false);
 assert.equal(s.evidenceMatrix.element.options[0].shape.keywordGroupId.safeParse(null).success,true);
 assert.equal(s.evidenceMatrix.element.options[0].shape.keywordGroupId.safeParse('invented').success,false);
 assert.equal(s.keywordLanding.safeParse([]).success,false);
 assert.equal(s.keywordLanding.element.shape.evidenceIds.safeParse(['invented']).success,false);
 assert.doesNotThrow(()=>createStructuredResponseFormat(schema,'ProductEmpty'));
});

test('product wire empty VOC and combined evidence sets remain fail closed',()=>{
 const input=evidenceScopedInput('manual');input.keywords.groups=[];input.keywords.evidence=[];
 const clear=(value:unknown):void=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(clear);return;}for(const [key,item] of Object.entries(value)){if(key==='evidenceIds')(value as Record<string,unknown>)[key]=[];else clear(item);}};clear(input.voc.result);
 input.voc.result.themeJudgments=[];
 const schema=createProductDefinitionModelOutputSchema(input),s=schema.shape;
 assert.equal(s.evidenceMatrix.element.options[1].shape.vocEvidenceIds.safeParse([]).success,true);
 assert.equal(s.evidenceMatrix.element.options[1].shape.vocEvidenceIds.safeParse(['invented']).success,false);
 assert.equal(s.evidenceMatrix.element.options[1].shape.themeKey.safeParse(null).success,true);
 assert.equal(s.evidenceMatrix.element.options[1].shape.themeKey.safeParse('invented').success,false);
 assert.equal(s.configurationLayers.shape.mustHave.safeParse([]).success,true);
 assert.equal(s.configurationLayers.shape.mustHave.safeParse([{item:'x',evidenceIds:['invented']}]).success,false);
 assert.equal(s.priorities.element.shape.evidenceIds.safeParse([]).success,false);
 assert.equal(s.priorities.element.shape.evidenceIds.safeParse(['invented']).success,false);
 assert.doesNotThrow(()=>createStructuredResponseFormat(schema,'ProductAllEmpty'));
});

test('product semantic diagnostics expose closed rule ids without candidate text',()=>{
 const input=evidenceScopedInput('manual'),base=canonicalizeProductDefinitionOutput(validOutput(input),input) as ReturnType<typeof validOutput>;
 const parsed=createProductDefinitionOutputSchema(input).safeParse({...base,finalDefinition:[{...base.finalDefinition[0],conclusion:'PRIVATE_BODY',vocEvidenceIds:[],keywordEvidenceIds:[]}]});
 assert.equal(parsed.success,false);if(parsed.success)return;
 const issues=summarizeZodValidationIssues(parsed.error,createStructuredResponseFormat(createProductDefinitionModelOutputSchema(input),'Product'));
 assert.ok(issues.some(i=>i.ruleId==='product-final-definition-needs-evidence'));
 assert.ok(issues.some(i=>i.ruleId==='product-supported-requires-both-evidence'));
 assert.doesNotMatch(JSON.stringify(issues),/PRIVATE_BODY|message/);
});

test('product wire row unions encode evidence sides before root semantic validation',()=>{
 const input=evidenceScopedInput('manual'),p=createProductDefinitionModelOutputSchema(input).shape,base=validOutput(input);
 const row=base.evidenceMatrix[0];
 for(const judgment of ['dual-validation','conflict','avoid']){
  assert.equal(p.evidenceMatrix.element.safeParse({...row,judgment}).success,true);
  for(const change of [{vocEvidenceIds:[]},{keywordEvidenceIds:[]},{themeKey:null},{keywordGroupId:null}])assert.equal(p.evidenceMatrix.element.safeParse({...row,judgment,...change}).success,false);
 }
 const voc={...row,judgment:'voc-only',keywordGroupId:null,keywordEvidenceIds:[]};
 const kw={...row,judgment:'keyword-candidate',themeKey:null,vocEvidenceIds:[]};
 assert.equal(p.evidenceMatrix.element.safeParse(voc).success,true);assert.equal(p.evidenceMatrix.element.safeParse(kw).success,true);
 assert.equal(p.evidenceMatrix.element.safeParse({...voc,keywordEvidenceIds:row.keywordEvidenceIds}).success,false);
 assert.equal(p.evidenceMatrix.element.safeParse({...kw,vocEvidenceIds:row.vocEvidenceIds}).success,false);
 const final=base.finalDefinition[0];assert.equal(p.finalDefinition.element.safeParse(final).success,true);
 assert.equal(p.finalDefinition.element.safeParse({...final,vocEvidenceIds:[]}).success,false);
 for(const change of [{vocEvidenceIds:[]},{keywordEvidenceIds:[]}])assert.equal(p.finalDefinition.element.safeParse({...final,validationStatus:'requires-validation',...change}).success,true);
 assert.equal(p.finalDefinition.element.safeParse({...final,validationStatus:'requires-validation',vocEvidenceIds:[],keywordEvidenceIds:[]}).success,false);
});

test('product closed guidance and shared definitions are safe and deterministic',()=>{
 const input=evidenceScopedInput('manual'),contract=createProductDefinitionModelOutputContract(input);
 const format=createStructuredResponseFormat(contract.schema,'Product',contract.schemaDefinitions);
 assert.match(JSON.stringify(format.format.schema),/#\/definitions\/ProductVocEvidenceId/);
 assert.ok(JSON.stringify(format.format.schema).length < JSON.stringify(createStructuredResponseFormat(contract.schema,'Product').format.schema).length);
 const clone=structuredClone(input);clone.voc.result.themeJudgments.reverse();const repeat=createProductDefinitionModelOutputContract(clone);
 assert.equal(format.digest,createStructuredResponseFormat(repeat.schema,'Product',repeat.schemaDefinitions).digest);
 const declared=format.format.schema;
 for(const ruleId of Object.keys(PRODUCT_VALIDATION_RULES)){
  const safe=freezeSafeValidationIssues([{path:['finalDefinition'],code:'custom',ruleId}],declared);
  assert.equal(safe[0].ruleId,ruleId);assert.match(productDefinitionRepairGuidance(safe).join('\n'),new RegExp(ruleId));
 }
 const unsafe=freezeSafeValidationIssues([{path:['PRIVATE_FIELD'],code:'custom',ruleId:'PRIVATE_RULE'}],declared);
 assert.equal(unsafe[0].ruleId,undefined);assert.deepEqual(productDefinitionRepairGuidance(unsafe),[]);assert.doesNotMatch(JSON.stringify(unsafe),/PRIVATE/);
});
