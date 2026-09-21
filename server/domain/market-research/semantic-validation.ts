import {marketSpanFailure} from './shape-span-normalization';
import {marketSemanticValidationRuleId} from './semantic-validation-rules';
import {validateMarketOverviewSynthesisInputEvidence,validateMarketOverviewDimensionSynthesisOutput,validateMarketOverviewFinalSynthesisOutput} from './overview-synthesis';
import {validateMarketShapeExplanationCatalog} from './shape-explanation-catalog';
import {validateMarketShapeExplanationWindow} from './shape-explanation-wire';
import {validateMarketShapeExplanationFragment} from './shape-explanation-fragments';
import {validateMarketShapeSynthesisInputEvidence,validateMarketShapeDimensionSynthesisOutput,validateMarketShapeFinalSynthesisOutput} from './shape-explanation-synthesis';
import {isValidOverviewResponseShare} from './overview-response-share';
import { z } from 'zod';
import * as c from '../../../shared/market-semantic-contracts';
import { MarketInputRecordSchema } from '../../../shared/market-analysis-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { createMarketInputSnapshot } from './snapshot';
import { createMarketSourceEvidence } from './source-evidence';
import {validateOverviewAnalysis,validateOverviewAnalysisBrief} from './overview-analysis-validation';

type Binding = c.MarketSemanticValidationBinding;
type Field = c.MarketSemanticSourceField;
function fail(code: string, path: (string | number)[] = []): never {
  const ruleId = marketSemanticValidationRuleId(code);
  throw new z.ZodError([{ code: 'custom', message: code, path, ...(ruleId ? { params: { ruleId } } : {}) }]);
}
function safe(value: unknown): void {
  const parsed = MarketInputRecordSchema.shape.data.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 8_000_000) fail('unsafe_json');
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  // Preserve structural diagnostics for bounded repair; never retain raw error prose.
  if (!result.success) throw new z.ZodError(result.error.issues.map(issue => ({ ...issue, message: 'invalid_schema' })));
  return result.data;
}
function equal(left: unknown, right: unknown, code: string): void { if (digest(left) !== digest(right)) fail(code); }
function unique(ids: readonly string[], code = 'duplicate_id'): Set<string> {
  const result = new Set(ids); if (result.size !== ids.length) fail(code); return result;
}
function sameSet(actual: readonly string[], expected: readonly string[], code: string): void {
  unique(actual, code); unique(expected, code); equal([...actual].sort(), [...expected].sort(), code);
}
function subset(ids: readonly string[], allowed: ReadonlySet<string>, code: string): void {
  unique(ids); if (ids.some(id => !allowed.has(id))) fail(code);
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function index<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  unique(values.map(key)); return new Map(values.map(value => [key(value), value]));
}

function prepareInput<I extends c.MarketSemanticInput>(
  inputValue: unknown, binding: Binding, inputSchema: z.ZodType<I>,
) {
  try {
  safe(inputValue); safe(binding);
  const input = parse(inputSchema, inputValue);
  const snapshot = binding.inputSnapshot;
  try {
    const rebuilt = createMarketInputSnapshot({ scope: snapshot.scope, kind: snapshot.kind, sourceVersion: snapshot.sourceVersion,
      ruleVersion: snapshot.ruleVersion, collectedAt: snapshot.collectedAt, expectedRecordIds: snapshot.expectedRecordIds, records: snapshot.records });
    equal(rebuilt, snapshot, 'snapshot_mismatch');
  } catch { fail('snapshot_mismatch'); }
  equal(snapshot.scope, binding.scope, 'scope_mismatch');
  const { organizationId: _organizationId, ...publicScope } = binding.scope;
  equal(input.scope, publicScope, 'scope_mismatch');
  if (input.scopeDigest !== digest(binding.scope) || input.contentSnapshotId !== snapshot.snapshotId) fail('scope_mismatch');
  if (input.selectionRevision !== binding.selectionRevision || input.batchKey !== binding.batchKey) fail('batch_mismatch');
  const { inputDigest: _inputDigest, ...projection } = input;
  if (digest(projection) !== input.inputDigest || input.inputDigest !== binding.inputDigest) fail('input_digest_mismatch');
  if (!Number.isFinite(Date.parse(input.dataCutoffAt)) || Date.parse(input.dataCutoffAt) > Date.now() || Date.parse(input.dataCutoffAt) < Date.parse(snapshot.collectedAt)) fail('invalid_cutoff');

  unique(input.sourceRefs);
  const sourceIds = new Set(input.sourceRefs);
  for (const sourceRef of input.sourceRefs) {
    const source = Object.hasOwn(binding.sourceEvidenceByRef, sourceRef) ? binding.sourceEvidenceByRef[sourceRef] : undefined;
    if (!source) fail('unknown_source');
    equal(source.scope, binding.scope, 'source_scope_mismatch');
    if (Date.parse(source.fetchedAt) > Date.parse(input.dataCutoffAt)) fail('invalid_cutoff');
    try {
      const responseIdentityPaths = Object.fromEntries(Object.entries(source.responseIdentity)
        .filter(([, check]) => check.echoes.length + check.missingPaths.length > 0)
        .map(([field, check]) => [field, [...check.echoes.map(echo => echo.path), ...check.missingPaths]]));
      const rebuilt = createMarketSourceEvidence({ scope: source.scope, provider: source.provider, operation: source.operation,
        requestIdentity: source.requestIdentity, responseIdentityPaths, payload: source.payload, fetchedAt: source.fetchedAt,
        observationPeriod: source.observationPeriod, units: source.units, coverage: source.coverage });
      equal(rebuilt, source, 'source_mismatch');
    } catch { fail('source_mismatch'); }
  }
  unique(binding.expectedIds);
  const records = new Map<string, c.MarketSemanticRecord>();
  for (const record of snapshot.records) {
    const data = record.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'semantic')) fail('catalog_mismatch');
    const semantic = parse(c.MarketSemanticRecordSchema, (data as Readonly<Record<string, unknown>>).semantic);
    if (semantic.task !== input.task) fail('catalog_mismatch');
    records.set(record.id, semantic);
  }
  equal(Object.fromEntries(records), binding.sourceCatalog, 'catalog_mismatch');
  if (!binding.expectedIds.length || binding.expectedIds.some(id => !records.has(id) || !snapshot.expectedRecordIds.includes(id))) fail('member_partition_mismatch');
  const batch = binding.expectedIds.map(id => records.get(id)!);
  let specific: Record<string, unknown>;
  if (input.task === 'market-overview-explanation') {
    if (snapshot.kind !== 'overview' || batch.length !== 1 || batch[0].task !== input.task) fail('member_partition_mismatch');
    const { task: _task, ...fields } = batch[0]; specific = fields;
  } else if (input.task === 'market-shape-structure-explanation') {
    if (snapshot.kind !== 'overview' || batch.length !== 1 || batch[0].task !== input.task) fail('member_partition_mismatch');
    if (!binding.shapeExplanationCatalog) fail('missing_shape_explanation_catalog');
    const catalog = validateMarketShapeExplanationCatalog(binding.shapeExplanationCatalog);
    const {requestedAsins:_requested,eligibleAsins:_eligible,...scope}=catalog.scope;
    equal(scope,binding.scope,'scope_mismatch');
    if(input.selectionRevision!==catalog.revisionId || input.dataCutoffAt!==catalog.source.dataCutoffAt) fail('shape_revision_mismatch');
    validateMarketShapeExplanationWindow(catalog,input.window);
    sameSet(batch[0].sourceRefs,catalog.source.sourceRefs,'evidence_union_mismatch');
    specific={window:batch[0].window};
  } else if (input.task === 'market-shape-synthesis') {
    if(snapshot.kind!=='overview'||batch.length!==1||batch[0].task!==input.task)fail('member_partition_mismatch');
    if(!binding.shapeExplanationCatalog||!binding.shapeSynthesisChildren||!binding.shapeSynthesisExpectedLeaves)fail('missing_shape_synthesis_evidence');
    const catalog=validateMarketShapeExplanationCatalog(binding.shapeExplanationCatalog);
    const {requestedAsins:_requested,eligibleAsins:_eligible,...scope}=catalog.scope;
    equal(scope,binding.scope,'scope_mismatch');
    if(input.selectionRevision!==catalog.revisionId||input.dataCutoffAt!==catalog.source.dataCutoffAt)fail('shape_revision_mismatch');
    validateMarketShapeSynthesisInputEvidence(catalog,input.synthesis,binding.shapeSynthesisChildren,binding.shapeSynthesisExpectedLeaves);
    equal(binding.expectedIds,[input.synthesis.nodeId],'member_identity_mismatch');
    sameSet(batch[0].sourceRefs,catalog.source.sourceRefs,'evidence_union_mismatch');
    specific={synthesis:batch[0].synthesis};
  } else if (input.task === 'market-overview-synthesis') {
    if(snapshot.kind!=='overview'||batch.length!==1||batch[0].task!==input.task)fail('member_partition_mismatch');
    if(!binding.overviewSynthesisBasis||!binding.overviewSynthesisChildren||!binding.overviewSynthesisExpectedLeaves)fail('missing_overview_synthesis_evidence');
    const basis=binding.overviewSynthesisBasis;
    equal(basis.scope,binding.scope,'scope_mismatch');
    if(input.selectionRevision!==basis.selectionRevision||input.dataCutoffAt!==basis.dataCutoffAt)fail('overview_revision_mismatch');
    validateMarketOverviewSynthesisInputEvidence(basis,input.synthesis,binding.overviewSynthesisChildren,binding.overviewSynthesisExpectedLeaves);
    equal(binding.expectedIds,[input.synthesis.nodeId],'member_identity_mismatch');
    sameSet(batch[0].sourceRefs,[...new Set([...basis.facts,...basis.gaps,...basis.metrics].flatMap(value=>value.sourceRefs))],'evidence_union_mismatch');
    specific={synthesis:batch[0].synthesis};
  } else if (input.task === 'market-product-shape-suggestion') {
    if (snapshot.kind !== 'products') fail('scope_mismatch');
    const products: c.MarketShapeSuggestionInput['products'] = [];
    for (const record of batch) {
      if (record.task !== input.task) fail('catalog_mismatch');
      const { task: _task, product, ...catalog } = record;
      equal(catalog, { taxonomyVersion: input.taxonomyVersion, allowedLabels: input.allowedLabels }, 'projection_mismatch');
      products.push(product);
    }
    specific = { taxonomyVersion: input.taxonomyVersion, allowedLabels: input.allowedLabels, products };
  } else if (input.task === 'market-keyword-semantics') {
    if (snapshot.kind !== 'keywords') fail('scope_mismatch');
    const keywords: c.MarketKeywordSemanticsInput['keywords'] = [];
    const mode = {...(input.outputProtocol===undefined?{}:{outputProtocol:input.outputProtocol}),...(input.discoveryMode === undefined ? {} : { discoveryMode: input.discoveryMode }),...(input.reconciliationDimension===undefined?{}:{reconciliationDimension:input.reconciliationDimension})};
    for (const record of batch) {
      if (record.task !== input.task) fail('catalog_mismatch');
      const { task: _task, keyword, ...catalog } = record;
      equal(catalog, { dictionaryVersion: input.dictionaryVersion, categoryContext: input.categoryContext, dimensionLabels: input.dimensionLabels, clusterCatalog: input.clusterCatalog, ...mode }, 'projection_mismatch');
      keywords.push(keyword);
    }
    specific = { dictionaryVersion: input.dictionaryVersion, categoryContext: input.categoryContext, dimensionLabels: input.dimensionLabels, clusterCatalog: input.clusterCatalog, ...mode, keywords };
  } else {
    if (snapshot.kind !== 'customer-themes') fail('scope_mismatch');
    const themes: c.MarketCustomerThemeMappingInput['themes'] = [];
    const mode = input.mappingMode === undefined ? {} : { mappingMode: input.mappingMode };
    for (const record of batch) {
      if (record.task !== input.task) fail('catalog_mismatch');
      const { task: _task, theme, ...catalog } = record;
      equal(catalog, { mappingVersion: input.mappingVersion, selectedAsins: input.selectedAsins, groupCatalog: input.groupCatalog, ...mode }, 'projection_mismatch');
      themes.push(theme);
    }
    specific = { mappingVersion: input.mappingVersion, selectedAsins: input.selectedAsins, groupCatalog: input.groupCatalog, ...mode, themes };
  }
  for (const [key, value] of Object.entries(specific)) equal(value, input[key as keyof I], 'projection_mismatch');

  const fields = new Map<string, Field>();
  const usedSources = new Set<string>();
  function add(field: Field, owner: string, role: Field['field']) {
    if (field.recordId !== owner || field.field !== role) fail('source_field_mismatch');
    if (!sourceIds.has(field.sourceRef)) fail('unknown_source');
    if (fields.has(field.refId)) fail('duplicate_id');
    fields.set(field.refId, field); usedSources.add(field.sourceRef);
  }
  if (input.task === 'market-product-shape-suggestion') {
    equal(input.products.map(p => p.productId), binding.expectedIds, 'member_partition_mismatch');
    unique(input.allowedLabels.map(label => label.labelId));
    for (const p of input.products) {
      if (p.productId !== p.asin) fail('member_identity_mismatch');
      if (p.title.state === 'known') add(p.title.value, p.productId, 'title');
      if (p.parameters.state === 'known') for (const field of p.parameters.value) add(field, p.productId, 'parameter');
    }
  } else if (input.task === 'market-keyword-semantics') {
    equal(input.keywords.map(k => k.keywordId), binding.expectedIds, 'member_partition_mismatch');
    if(input.outputProtocol!==undefined&&input.discoveryMode===undefined&&input.reconciliationDimension===undefined)fail('explicit_keyword_mode_required');
    if(input.reconciliationDimension!==undefined){
      if(input.discoveryMode!==undefined)fail('mixed_keyword_modes');
      for(const dimension of ['W1','W2','W3','W4'] as const)if(dimension!==input.reconciliationDimension&&input.dimensionLabels[dimension].length)fail('inactive_reconciliation_catalog');
      if(input.reconciliationDimension!=='cluster'&&input.clusterCatalog.length)fail('inactive_reconciliation_catalog');
    }
    for (const labels of Object.values(input.dimensionLabels)) unique(labels.map(label => label.labelId));
    unique(input.clusterCatalog.map(cluster => cluster.clusterId));
    for (const k of input.keywords) add(k.text, k.keywordId, 'keyword');
  } else if (input.task === 'market-customer-theme-mapping') {
    equal(input.themes.map(t => t.sourceThemeId), binding.expectedIds, 'member_partition_mismatch');
    const selected = unique(input.selectedAsins); unique(input.groupCatalog.map(group => group.groupId));
    for (const t of input.themes) {
      if (!selected.has(t.asin)) fail('member_identity_mismatch');
      if (t.keyword.state === 'known') add(t.keyword.value, t.sourceThemeId, 'keyword');
      if (t.content.state === 'known') add(t.content.value, t.sourceThemeId, 'content');
    }
  } else if(input.task==='market-overview-synthesis') {
    for(const item of [...binding.overviewSynthesisBasis!.facts,...binding.overviewSynthesisBasis!.gaps,...binding.overviewSynthesisBasis!.metrics])for(const ref of item.sourceRefs)usedSources.add(ref);
  } else if(input.task === 'market-shape-structure-explanation'||input.task==='market-shape-synthesis') {
    for(const ref of binding.shapeExplanationCatalog!.source.sourceRefs)usedSources.add(ref);
  } else for (const item of [...input.metrics, ...input.gaps, ...input.facts]) for (const ref of item.sourceRefs) usedSources.add(ref);
  sameSet([...usedSources], input.sourceRefs, 'evidence_union_mismatch');
  if (input.task === 'market-overview-explanation') validateOverviewCatalog(input);
  return { input, fields };
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    fail('invalid_schema');
  }
}

function prepare<I extends c.MarketSemanticInput, O extends c.MarketSemanticOutput>(
  inputValue: unknown, outputValue: unknown, binding: Binding, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>,
) {
  safe(inputValue); safe(outputValue); safe(binding);
  const output = parse(outputSchema, outputValue);
  const prepared = prepareInput(inputValue, binding, inputSchema);
  if (output.inputDigest !== prepared.input.inputDigest || output.batchId !== prepared.input.batchId || output.task !== prepared.input.task) fail('output_identity_mismatch');
  return { ...prepared, output };
}

/** Verify a persisted batch before any provider dispatch; this does not produce an analysis. */
export function validateMarketSemanticInput(inputValue: unknown, binding: Binding): c.MarketSemanticInput {
  safe(inputValue);
  const task = parse(z.object({ task: c.MarketSemanticTaskNameSchema }).passthrough(), inputValue).task;
  switch (task) {
    case 'market-shape-structure-explanation': return frozen(prepareInput(inputValue,binding,c.MarketShapeStructureExplanationInputSchema).input);
    case 'market-overview-synthesis': return frozen(prepareInput(inputValue,binding,c.MarketOverviewSynthesisInputSchema).input);
    case 'market-shape-synthesis': return frozen(prepareInput(inputValue,binding,c.MarketShapeSynthesisInputSchema).input);
    case 'market-overview-explanation': return frozen(prepareInput(inputValue, binding, c.MarketOverviewExplanationInputSchema).input);
    case 'market-product-shape-suggestion': return frozen(prepareInput(inputValue, binding, c.MarketShapeSuggestionInputSchema).input);
    case 'market-keyword-semantics': return frozen(prepareInput(inputValue, binding, c.MarketKeywordSemanticsInputSchema).input);
    case 'market-customer-theme-mapping': return frozen(prepareInput(inputValue, binding, c.MarketCustomerThemeMappingInputSchema).input);
  }
}

function spans(values: readonly c.MarketTextSpanRef[], fields: Map<string, Field>, owners: ReadonlySet<string>, path: (string | number)[] = []): Set<string> {
  const seen = new Set<string>();
  const cited = new Set<string>();
  for (const [spanIndex, value] of values.entries()) {
    const spanPath = [...path, spanIndex];
    const spanKey = `${value.refId}:${value.start}:${value.end}`;
    if(seen.has(spanKey))fail('duplicate_id',spanPath);
    seen.add(spanKey);
    const field = fields.get(value.refId);
    if (!field || !owners.has(field.recordId)) fail('span_unknown_or_foreign_reference',spanPath);
    const { text } = field;
    const reason = marketSpanFailure(value,text);
    if(reason)fail(reason,spanPath);
    cited.add(field.recordId);
  }
  return cited;
}
function unknown(decision: z.infer<typeof c.MarketSemanticUnknownSchema>, fields: Map<string, Field>, owner: string, hasMissing: boolean, path: (string | number)[] = []) {
  if (decision.reason === 'missing-source' && !hasMissing) fail('source_not_missing', [...path,'reason']);
  spans(decision.evidence, fields, new Set([owner]), [...path,'evidence']);
}
function partition<T>(items: T[], expected: readonly string[], key: (item: T) => string): T[] {
  sameSet(items.map(key), expected, 'member_partition_mismatch');
  const mapped = new Map(items.map(item => [key(item), item])); return expected.map(id => mapped.get(id)!);
}

export function validateMarketShapeSuggestions(inputValue: unknown, candidate: unknown, binding: Binding): c.MarketShapeSuggestionOutput {
  const { input, output, fields } = prepare(inputValue, candidate, binding, c.MarketShapeSuggestionInputSchema, c.MarketShapeSuggestionOutputSchema);
  const originalProductIndexes = new Map(output.products.map((product,i)=>[product.productId,i]));
  output.products = partition(output.products, input.products.map(p => p.productId), p => p.productId);
  const labels = new Set(input.allowedLabels.map(label => label.labelId));
  for (const [i, product] of output.products.entries()) {
    const source = input.products[i], decision = product.decision, outputIndex=originalProductIndexes.get(product.productId)!;
    if (decision.status === 'unknown') unknown(decision, fields, product.productId, source.title.state === 'missing' || source.parameters.state === 'missing', ['products',outputIndex,'decision']);
    else {
      subset(decision.candidates.map(c => c.labelId), labels, 'unknown_label');
      for (const [ci,suggestion] of decision.candidates.entries()) spans(suggestion.evidence, fields, new Set([product.productId]), ['products',outputIndex,'decision','candidates',ci,'evidence']);
    }
  }
  return frozen(output);
}

export function validateMarketKeywordSemantics(inputValue: unknown, candidate: unknown, binding: Binding): c.MarketKeywordSemanticsOutput {
  safe(inputValue);
  const admittedInput = parse(c.MarketKeywordSemanticsInputSchema, inputValue);
  const discovery = admittedInput.discoveryMode === 'labels-and-clusters/v1';
  const outputSchema = discovery ? c.MarketKeywordSemanticsDiscoveryOutputSchema : c.MarketKeywordSemanticsOutputSchema;
  const { input, output, fields } = prepare(inputValue, candidate, binding, c.MarketKeywordSemanticsInputSchema, outputSchema);
  if (!discovery && Object.hasOwn(output, 'labelProposals')) fail('label_proposals_not_allowed');
  if(input.reconciliationDimension!==undefined&&(output.proposals.length||output.synonymRelations.length))fail('reconciliation_proposals_not_allowed');
  const members = input.keywords.map(k => k.keywordId), memberSet = new Set(members);
  const originalKeywordIndexes = new Map(output.keywords.map((keyword,i)=>[keyword.keywordId,i]));
  output.keywords = partition(output.keywords, members, k => k.keywordId);
  const proposals = index(output.proposals, p => p.proposalId), assigned = new Map<string, Set<string>>();
  const labelProposals = index(output.labelProposals ?? [], p => p.labelId);
  const proposedAssignments = new Map<string, Set<string>>();
  const inputLabelIds = new Set(Object.values(input.dimensionLabels).flatMap(labels => labels.map(item => item.labelId)));
  for (const proposal of labelProposals.values()) if (inputLabelIds.has(proposal.labelId)) fail('label_id_collision');
  const clusters = new Set(input.clusterCatalog.map(cluster => cluster.clusterId));
  for (const keyword of output.keywords) {
    const ki=originalKeywordIndexes.get(keyword.keywordId)!;
    for (const dimension of ['W1', 'W2', 'W3', 'W4'] as const) {
      const decision = keyword[dimension];
      if(input.reconciliationDimension!==undefined&&dimension!==input.reconciliationDimension&&decision.status!=='unknown')fail('inactive_reconciliation_decision');
      if (decision.status === 'unknown') unknown(decision, fields, keyword.keywordId, false, ['keywords',ki,dimension]);
      else {
        unique(decision.labelIds);
        const existing = new Set(input.dimensionLabels[dimension].map(item => item.labelId));
        for (const labelId of decision.labelIds) {
          if (existing.has(labelId)) continue;
          const proposed = labelProposals.get(labelId);
          if (!proposed) fail('unknown_label');
          if (proposed.dimension !== dimension) fail('wrong_dimension_label');
          const owners = proposedAssignments.get(labelId) ?? new Set<string>();
          owners.add(keyword.keywordId); proposedAssignments.set(labelId, owners);
        }
        spans(decision.evidence, fields, new Set([keyword.keywordId]), ['keywords',ki,dimension,'evidence']);
      }
    }
    const cluster = keyword.cluster;
    if(input.reconciliationDimension!==undefined&&input.reconciliationDimension!=='cluster'&&cluster.status!=='unknown')fail('inactive_reconciliation_decision');
    if (cluster.status === 'unknown') unknown(cluster, fields, keyword.keywordId, false, ['keywords',ki,'cluster']);
    else {
      spans(cluster.evidence, fields, new Set([keyword.keywordId]), ['keywords',ki,'cluster','evidence']);
      if (cluster.status === 'existing' && !clusters.has(cluster.clusterId)) fail('unknown_cluster');
      if (cluster.status === 'proposed') {
        if (!proposals.has(cluster.proposalId)) fail('unknown_proposal');
        const owners = assigned.get(cluster.proposalId) ?? new Set<string>(); owners.add(keyword.keywordId); assigned.set(cluster.proposalId, owners);
      }
    }
  }
  for (const [pi,proposal] of output.proposals.entries()) {
    const owners = assigned.get(proposal.proposalId); if (!owners) fail('unused_proposal');
    spans(proposal.evidence, fields, owners, ['proposals',pi,'evidence']);
  }
  for (const [pi,proposal] of [...labelProposals.values()].entries()) {
    const owners = proposedAssignments.get(proposal.labelId); if (!owners) fail('unused_label_proposal');
    spans(proposal.evidence, fields, owners, ['labelProposals',pi,'evidence']);
  }
  const relations = new Set<string>();
  for (const [ri,relation] of output.synonymRelations.entries()) {
    const pair = [relation.leftKeywordId, relation.rightKeywordId];
    if (pair[0] === pair[1] || pair.some(id => !memberSet.has(id))) fail('invalid_relation');
    const key = JSON.stringify([...pair].sort()); if (relations.has(key)) fail('duplicate_relation'); relations.add(key);
    const cited = spans(relation.evidence, fields, new Set(pair), ['synonymRelations',ri,'evidence']);
    if (pair.some(id => !cited.has(id))) fail('endpoint_evidence_missing');
  }
  return frozen(output);
}

export function validateMarketCustomerThemeMapping(inputValue: unknown, candidate: unknown, binding: Binding): c.MarketCustomerThemeMappingOutput {
  const { input, output, fields } = prepare(inputValue, candidate, binding, c.MarketCustomerThemeMappingInputSchema, c.MarketCustomerThemeMappingOutputSchema);
  if(input.mappingMode==='catalog-only' && (output.proposals.length || output.themes.some(t=>t.decision.status==='mapped'&&t.decision.target.kind==='proposed')))fail('catalog_only_proposal');
  const originalThemeIndexes = new Map(output.themes.map((theme,i)=>[theme.sourceThemeId,i]));
  output.themes = partition(output.themes, input.themes.map(t => t.sourceThemeId), t => t.sourceThemeId);
  const groups = new Set(input.groupCatalog.map(group => group.groupId));
  const proposals = index(output.proposals, p => p.proposalId), assigned = new Map<string, Set<string>>();
  for (const [i, theme] of output.themes.entries()) {
    const decision = theme.decision, source = input.themes[i], outputIndex=originalThemeIndexes.get(theme.sourceThemeId)!;
    if (decision.status === 'unknown') unknown(decision, fields, theme.sourceThemeId, source.keyword.state === 'missing' || source.content.state === 'missing', ['themes',outputIndex,'decision']);
    else {
      spans(decision.evidence, fields, new Set([theme.sourceThemeId]), ['themes',outputIndex,'decision','evidence']);
      if (decision.target.kind === 'existing' && !groups.has(decision.target.groupId)) fail('unknown_group');
      if (decision.target.kind === 'proposed') {
        if (!proposals.has(decision.target.proposalId)) fail('unknown_proposal');
        const owners = assigned.get(decision.target.proposalId) ?? new Set<string>(); owners.add(theme.sourceThemeId); assigned.set(decision.target.proposalId, owners);
      }
    }
  }
  for (const [pi,proposal] of output.proposals.entries()) {
    const owners = assigned.get(proposal.proposalId); if (!owners) fail('unused_proposal');
    spans(proposal.evidence, fields, owners, ['proposals',pi,'evidence']);
  }
  return frozen(output);
}

function validateOverviewCatalog(input: c.MarketOverviewExplanationInput) {
  validateOverviewAnalysisBrief(input);
  const metrics = index(input.metrics, m => m.metricId), facts = index(input.facts, f => f.factId), gaps = index(input.gaps, g => g.gapId);
  const options = index(input.interpretationOptions, o => o.optionId), actions = index(input.validationOptions, a => a.actionId);
  const sourceIds = new Set(input.sourceRefs), factIds = new Set(facts.keys()), gapIds = new Set(gaps.keys());
  for (const metric of input.metrics) {
    subset(metric.sourceRefs, sourceIds, 'unknown_source');
    if (metric.coverage.availableCount > metric.coverage.expectedCount ||
      (metric.coverage.status === 'complete') !== (metric.coverage.availableCount === metric.coverage.expectedCount)) fail('invalid_coverage');
    if (metric.unit.unit === 'currency' ? metric.unit.currency !== input.scope.currency : metric.unit.currency !== undefined) fail('invalid_unit');
    // Rule-derived means may be fractional even when the measurement unit is count.
    if (metric.unit.unit === 'count' && (metric.value < 0 || metric.value > Number.MAX_SAFE_INTEGER)) fail('invalid_metric');
    // A known source value may have an explicitly unknown observation period.
    // It can describe that response, but cannot support period-derived metrics.
    const responseShare=metric.formulaVersion==='overview-response-group-share/v1';
    if(responseShare&&!isValidOverviewResponseShare(metric,metrics))fail('invalid_metric');
    if (metric.period.kind === 'unknown' && (metric.numeratorRef !== null || metric.denominatorRef !== null)&&!responseShare) fail('invalid_period');
    if (metric.period.kind === 'calendar-months' && (metric.period.fromMonth > metric.period.toMonth || metric.period.fromMonth < input.scope.fromMonth || metric.period.toMonth > input.scope.toMonth)) fail('invalid_period');
    if ((metric.period.kind === 'current' || metric.period.kind === 'trailing-days') && Date.parse(metric.period.asOf) > Date.parse(input.dataCutoffAt)) fail('invalid_period');
    for (const ref of [metric.numeratorRef, metric.denominatorRef]) if (ref !== null && !metrics.has(ref)) fail('unknown_metric');
  }
  for (const gap of input.gaps) subset(gap.sourceRefs, sourceIds, 'unknown_source');
  for (const fact of input.facts) {
    subset(fact.metricRefs, new Set(metrics.keys()), 'unknown_metric');
    if (fact.kind === 'trend' && fact.metricRefs.some(id => metrics.get(id)!.period.kind === 'unknown')) fail('invalid_period');
    const refs = [...new Set(fact.metricRefs.flatMap(id => metrics.get(id)!.sourceRefs))];
    sameSet(fact.sourceRefs, refs, 'evidence_union_mismatch');
  }
  for (const option of input.interpretationOptions) {
    subset(option.allowedFactIds, factIds, 'unknown_fact'); subset(option.allowedGapIds, gapIds, 'unknown_gap');
    subset(option.requiredFactIds, new Set(option.allowedFactIds), 'required_evidence_missing'); subset(option.requiredGapIds, new Set(option.allowedGapIds), 'required_evidence_missing');
  }
  for (const action of input.validationOptions) { subset(action.allowedFactIds, factIds, 'unknown_fact'); subset(action.allowedGapIds, gapIds, 'unknown_gap'); }
  return { metrics, facts, gaps, options, actions, factIds, gapIds };
}

export function validateMarketOverviewExplanation(inputValue: unknown, candidate: unknown, binding: Binding): c.MarketOverviewExplanationOutput {
  const { input, output } = prepare(inputValue, candidate, binding, c.MarketOverviewExplanationInputSchema, c.MarketOverviewExplanationOutputSchema);
  const { facts, gaps, options, actions, factIds, gapIds } = validateOverviewCatalog(input);
  validateOverviewAnalysis(input,output.analysis);
  function selection(value: { factIds: string[]; gapIds?: string[]; evidenceRefs: string[] }) {
    subset(value.factIds, factIds, 'unknown_fact'); subset(value.gapIds ?? [], gapIds, 'unknown_gap');
    const sources = [...new Set([...value.factIds.flatMap(id => facts.get(id)!.sourceRefs), ...(value.gapIds ?? []).flatMap(id => gaps.get(id)!.sourceRefs)])];
    sameSet(value.evidenceRefs, sources, 'evidence_union_mismatch');
  }
  function option(value: { optionId: string; factIds: string[]; gapIds: string[]; evidenceRefs: string[] }, kind: 'inference' | 'risk') {
    const allowed = options.get(value.optionId); if (!allowed) fail('unknown_option');
    if (allowed.kind !== kind) fail('option_kind_mismatch');
    subset(value.factIds, new Set(allowed.allowedFactIds), 'unknown_fact'); subset(value.gapIds, new Set(allowed.allowedGapIds), 'unknown_gap');
    subset(allowed.requiredFactIds, new Set(value.factIds), 'required_evidence_missing'); subset(allowed.requiredGapIds, new Set(value.gapIds), 'required_evidence_missing');
    selection(value);
  }
  unique(output.findings.map(f => f.findingId)); unique(output.risks.map(r => r.optionId)); unique(output.validationTasks.map(t => t.actionId));
  for (const finding of output.findings) if (finding.mode === 'observed') selection(finding); else option(finding, 'inference');
  for (const risk of output.risks) option(risk, 'risk');
  for (const task of output.validationTasks) {
    const action = actions.get(task.actionId); if (!action) fail('unknown_action');
    subset(task.factIds, new Set(action.allowedFactIds), 'unknown_fact'); subset(task.gapIds, new Set(action.allowedGapIds), 'unknown_gap'); selection(task);
  }
  return frozen(output);
}

/** UI data only: every displayed numeric value is dereferenced from the frozen input catalog. */
export function renderMarketOverviewExplanation(inputValue: unknown, candidate: unknown, binding: Binding) {
  const output = validateMarketOverviewExplanation(inputValue, candidate, binding);
  const input = parse(c.MarketOverviewExplanationInputSchema, inputValue);
  const metrics = new Map(input.metrics.map(metric => [metric.metricId, metric]));
  const facts = new Map(input.facts.map(fact => [fact.factId, fact]));
  return frozen({ ...output, findings: output.findings.map(finding => ({ ...finding,
    facts: finding.factIds.map(id => { const fact = facts.get(id)!; return { ...fact, metrics: fact.metricRefs.map(ref => metrics.get(ref)!) }; }),
  })) });
}

/** The catalogue is loaded from the authorized immutable revision by the native
 * execution service; a model request cannot supply or replace it. */
export function validateMarketShapeStructureExplanation(inputValue:unknown,candidate:unknown,binding:Binding):c.MarketShapeStructureExplanationOutput {
  const {input,output}=prepare(inputValue,candidate,binding,c.MarketShapeStructureExplanationInputSchema,c.MarketShapeStructureExplanationOutputSchema);
  return frozen({...output,fragment:validateMarketShapeExplanationFragment(binding.shapeExplanationCatalog!,input.window,output.fragment)});
}

export function validateMarketShapeSynthesisOutput(inputValue:unknown,candidate:unknown,binding:Binding):c.MarketShapeSynthesisOutput {
  const {input,output}=prepare(inputValue,candidate,binding,c.MarketShapeSynthesisInputSchema,c.MarketShapeSynthesisOutputSchema);
  try {
    if(input.synthesis.mode==='dimension-reduce')validateMarketShapeDimensionSynthesisOutput(binding.shapeExplanationCatalog!,input.synthesis,output.result);
    else validateMarketShapeFinalSynthesisOutput(binding.shapeExplanationCatalog!,input.synthesis,output.result);
  } catch(error) {
    if(error instanceof z.ZodError)throw error;
    fail(error instanceof TypeError?error.message:'invalid_synthesis_output',['result']);
  }
  return frozen(output);
}

export function validateMarketOverviewSynthesisOutput(inputValue:unknown,candidate:unknown,binding:Binding):c.MarketOverviewSynthesisOutput {
  const {input,output}=prepare(inputValue,candidate,binding,c.MarketOverviewSynthesisInputSchema,c.MarketOverviewSynthesisOutputSchema);
  try {
    if(input.synthesis.mode==='dimension-reduce')validateMarketOverviewDimensionSynthesisOutput(input.synthesis,output.result);
    else validateMarketOverviewFinalSynthesisOutput(input.synthesis,output.result);
  } catch(error) {
    if(error instanceof z.ZodError)throw error;
    fail(error instanceof TypeError?error.message:'invalid_overview_synthesis_output',['result']);
  }
  return frozen(output);
}
