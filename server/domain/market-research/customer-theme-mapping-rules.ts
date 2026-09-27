import { z } from 'zod';
import { MarketCustomerThemeMappingInputSchema, MarketSemanticRecordSchema, type MarketSemanticValidationBinding } from '../../../shared/market-semantic-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { assembleMarketThemePool, MarketThemePoolCatalogSchema } from './customer-theme-source-pool';
import { aggregateCustomerThemes, type CustomerThemeMapping, type CustomerThemesAsinInput } from './customer-themes';
import { validateMarketCustomerThemeMapping } from './semantic-validation';
import { localizeThemeLabel } from '../../../shared/market-theme-original-rules';

export const MARKET_THEME_MAPPING_RULE_VERSION = 'market-theme-mapping-rules/v1';
type Batch = { input: unknown; output: unknown; binding: MarketSemanticValidationBinding };
type Group = { groupId: string; labelZh: string; definition: string; origin: 'catalog' | 'batch-proposal' | 'local-rule'; batchId: string | null; proposalId: string | null };
type Decision = { sourceThemeId: string; status: 'mapped' | 'unknown' | 'unavailable'; groupId: string | null; reason: string | null; batchId: string | null };
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw new TypeError('Theme mapping rule lineage differs'); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function freeze<T>(v: T): T { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

/** Pure replay, with no model-generated arithmetic. The runtime must additionally
 * authorize and load successful audited batches and immutable collection receipts.
 * Proposals are deliberately batch-scoped until a separate reconciliation accepts
 * cross-batch relationships; identical Chinese labels are not proof of equivalence. */
export function calculateMarketThemeMappingRules(options: {
  poolInput: Parameters<typeof assembleMarketThemePool>[0]; batches: readonly Batch[]; topN?: number; originalRules?: boolean;
}) {
  // Rebuild T1/T4-backed inputs rather than trusting caller-provided totals or IDs.
  const pool = assembleMarketThemePool(options.poolInput), catalog = MarketThemePoolCatalogSchema.parse(options.poolInput.catalog);
  if (options.topN !== undefined) z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(options.topN);
  const snapshot = pool.semanticSnapshot, expected = new Set(snapshot.expectedRecordIds), seen = new Set<string>(), batchIds = new Set<string>();
  const sourceCatalog = Object.fromEntries(snapshot.records.map(r => [r.id, MarketSemanticRecordSchema.parse((r.data as { semantic?: unknown }).semantic)]));
  const groups = new Map<string, Group>(), mappings: CustomerThemeMapping[] = [], decisions: Decision[] = [];
  const audit: { batchId: string; batchKey: string; inputDigest: string; outputDigest: string; output: ReturnType<typeof validateMarketCustomerThemeMapping> }[] = [];
  if (options.originalRules) {
    if (options.batches.length) throw new TypeError('Original theme rules cannot include model batches');
    for (const record of pool.rawSnapshot.records) {
      const result = (record.data as { result: CustomerThemesAsinInput }).result;
      if (result.status !== 'success') continue;
      for (const theme of result.themes) {
        const keyword = theme.keyword.trim().toLowerCase();
        const groupId = `theme-local:${digest({ version: 'keyword-trim-lower/v1', keyword })}`;
        if (!groups.has(groupId)) groups.set(groupId, { groupId, labelZh: localizeThemeLabel(theme.keyword.trim()).slice(0, 60),
          definition: '按来源 keyword 去首尾空格并转小写后精确同名归并；未作语义归并。', origin: 'local-rule', batchId: null, proposalId: null });
        mappings.push({ sourceThemeId: theme.sourceThemeId, groupId });
        decisions.push({ sourceThemeId: theme.sourceThemeId, status: 'mapped', groupId, reason: null, batchId: null });
        seen.add(theme.sourceThemeId);
      }
    }
  }
  let selectionRevision: string | null = null;
  for (const batch of options.batches) {
    const input = MarketCustomerThemeMappingInputSchema.parse(batch.input);
    same(input.contentSnapshotId, snapshot.snapshotId); same(batch.binding.inputSnapshot, snapshot);
    same(input.dataCutoffAt, snapshot.collectedAt); same(input.selectedAsins, pool.manifest.selectedAsins);
    same(input.mappingVersion, catalog.mappingVersion); same(input.groupCatalog, catalog.groupCatalog);
    if (selectionRevision !== null) same(input.selectionRevision, selectionRevision); selectionRevision = input.selectionRevision;
    if (batchIds.has(input.batchId)) throw new TypeError('Duplicate theme model batch'); batchIds.add(input.batchId);
    const output = validateMarketCustomerThemeMapping(input, batch.output, { ...batch.binding, scope: snapshot.scope, inputSnapshot: snapshot,
      sourceEvidenceByRef: options.poolInput.sources, sourceCatalog });
    for (const t of output.themes) {
      if (!expected.has(t.sourceThemeId) || seen.has(t.sourceThemeId)) throw new TypeError('Overlapping or outside theme batch partition'); seen.add(t.sourceThemeId);
      const decision = t.decision;
      if (decision.status === 'unknown') { decisions.push({ sourceThemeId: t.sourceThemeId, status: 'unknown', groupId: null, reason: decision.reason, batchId: input.batchId }); continue; }
      const target = decision.target; let group: Group;
      if (target.kind === 'existing') {
        const entry = catalog.groupCatalog.find(g => g.groupId === target.groupId)!;
        group = { ...entry, origin: 'catalog', batchId: null, proposalId: null };
      } else {
        const proposal = output.proposals.find(p => p.proposalId === target.proposalId)!;
        const groupId = `theme-proposal:${digest({ version: MARKET_THEME_MAPPING_RULE_VERSION, scope: snapshot.scope, mappingVersion: catalog.mappingVersion,
          batchKey: input.batchKey, inputDigest: input.inputDigest, proposalId: proposal.proposalId, labelZh: proposal.labelZh, definition: proposal.definition })}`;
        if (catalog.groupCatalog.some(g => g.groupId === groupId)) throw new TypeError('Theme proposal collides with frozen catalog');
        group = { groupId, labelZh: proposal.labelZh, definition: proposal.definition, origin: 'batch-proposal', batchId: input.batchId, proposalId: proposal.proposalId };
      }
      const previous = groups.get(group.groupId); if (previous) same(previous, group); groups.set(group.groupId, group);
      mappings.push({ sourceThemeId: t.sourceThemeId, groupId: group.groupId });
      decisions.push({ sourceThemeId: t.sourceThemeId, status: 'mapped', groupId: group.groupId, reason: null, batchId: input.batchId });
    }
    audit.push({ batchId: input.batchId, batchKey: input.batchKey, inputDigest: input.inputDigest, outputDigest: digest(output), output });
  }
  const unavailableMemberIds = [...expected].filter(id => !seen.has(id)).sort(compare);
  for (const sourceThemeId of unavailableMemberIds) decisions.push({ sourceThemeId, status: 'unavailable', groupId: null, reason: 'model-result-unavailable', batchId: null });
  decisions.sort((a, b) => compare(a.sourceThemeId, b.sourceThemeId)); mappings.sort((a, b) => compare(a.sourceThemeId, b.sourceThemeId));
  audit.sort((a, b) => compare(a.batchId, b.batchId));
  const unknownMemberIds = decisions.filter(d => d.status === 'unknown').map(d => d.sourceThemeId);
  const proposedGroups = [...groups.values()].filter(g => g.origin === 'batch-proposal');
  const reconciliationRequired = proposedGroups.length > 0 && batchIds.size > 1;
  const aggregation = aggregateCustomerThemes({ selectedAsins: pool.manifest.selectedAsins,
    results: pool.rawSnapshot.records.map(r => (r.data as { result: CustomerThemesAsinInput }).result), mappings, topN: options.topN });
  const result = { ruleVersion: MARKET_THEME_MAPPING_RULE_VERSION, mappingVersion: catalog.mappingVersion, rawInputSnapshotId: pool.rawSnapshot.snapshotId,
    semanticInputSnapshotId: snapshot.snapshotId, selectionRevision, dataCutoffAt: snapshot.collectedAt,
    metricKind: pool.manifest.metricKind, reviewDeduplication: pool.manifest.reviewDeduplication, sharedPayloadGroups: pool.manifest.sharedPayloadGroups,
    aggregation, groups: [...groups.values()].sort((a, b) => compare(a.groupId, b.groupId)), decisions, batches: audit,
    semantics: { status: expected.size === 0 ? 'no-input' : seen.size === 0 ? 'unavailable' : unavailableMemberIds.length ? 'partial' :
      unknownMemberIds.length ? 'contains-unknown' : reconciliationRequired ? 'awaiting-reconciliation' : 'mapped',
      expectedMemberCount: expected.size, validatedMemberCount: seen.size, mappedMemberCount: mappings.length,
      unknownMemberIds, unavailableMemberIds, reconciliationRequired, proposalPolicy: 'batch-scoped-until-reconciled' } };
  return freeze({ ...result, resultHash: digest(result) });
}
