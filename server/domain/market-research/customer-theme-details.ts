import { z } from 'zod';
import type { MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { MarketThemeDetailQuerySchema, MarketThemeDetailPageSchema, MarketThemeDecisionSchema, MarketThemeLabelSchema } from '../../../shared/market-theme-detail-contracts';
import { createMarketInputSnapshot } from './snapshot';
import { aggregateCustomerThemes, type CustomerThemesAsinSummary } from './customer-themes';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { MARKET_THEME_EVALUATION_VERSION } from './customer-theme-reconciliation-artifact';
import { restoreMarketThemeEvaluation } from './customer-theme-evaluation-reader';
import { restoreMarketThemeAggregate } from './customer-theme-aggregate-reader';

const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw new TypeError('Theme detail artifact differs from its complete rule evidence'); };
export class MarketThemeDetailQueryError extends Error { constructor() { super('Theme detail page or group is outside this report'); } }
const preview = (text: string) => ({ text: text.slice(0, 2000), totalLength: text.length, truncated: text.length > 2000 });

/** Validate complete immutable chunks and replay T5 before slicing. Page boundaries
 * never become statistical boundaries, and model mapping does not supply counts. */
export function restoreMarketThemeDetails(snapshot: MarketInputSnapshot, emptySelection = false, priorEvaluations:readonly MarketInputSnapshot[]=[]) {
  if(snapshot.ruleVersion===MARKET_THEME_EVALUATION_VERSION){
    if(emptySelection)throw new TypeError('Evaluation is not an empty selection');
    const {aggregation,labels,decisions}=restoreMarketThemeEvaluation(snapshot,priorEvaluations);return {aggregation,labels,decisions};
  }
  if(priorEvaluations.length)throw new TypeError('Initial rules cannot use evaluation history');
  same(snapshot, createMarketInputSnapshot({ scope: snapshot.scope, kind: snapshot.kind, sourceVersion: snapshot.sourceVersion, ruleVersion: snapshot.ruleVersion,
    collectedAt: snapshot.collectedAt, expectedRecordIds: snapshot.expectedRecordIds, records: snapshot.records }));
  if (snapshot.coverage.status !== 'complete' && !(emptySelection && snapshot.expectedRecordIds.length === 0 && snapshot.records.length === 0)) throw new TypeError('Incomplete theme rule artifact');
  let aggregation: ReturnType<typeof aggregateCustomerThemes>;
  let labels: z.infer<typeof MarketThemeLabelSchema>[] = [], decisions: z.infer<typeof MarketThemeDecisionSchema>[] = [];
  if (emptySelection) {
    if (snapshot.kind !== 'products' || snapshot.records.length) throw new TypeError('Empty selection must have no members');
    aggregation = aggregateCustomerThemes({ selectedAsins: [], results: [], mappings: [] });
  } else {
    if (snapshot.kind !== 'customer-themes' || !snapshot.ruleVersion.startsWith('market-theme-mapping-rules/v1:')) throw new TypeError('Theme rules are required');
    const summary = obj(snapshot.records.find(r => r.id === 'summary')?.data), saved = obj(summary.aggregation);
    same(summary.artifactLayout, 'theme-rules-chunks/v1');
    same(snapshot.ruleVersion, `market-theme-mapping-rules/v1:${z.string().regex(/^[a-f0-9]{64}$/).parse(summary.resultHash)}`);
    const selection = z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(20).parse(obj(saved.scope).selectedAsins);
    const permitted = new Set(['summary', ...selection.map(asin => `asin:${asin}`)]);
    function chunks(name: string, size: number): unknown[] {
      const rows = snapshot.records.filter(r => r.id.startsWith(`${name}:`)).sort((a, b) => Number(a.id.slice(name.length + 1)) - Number(b.id.slice(name.length + 1)));
      return rows.flatMap((r, i) => {
        same(r.id, `${name}:${i}`); const data = obj(r.data); same(data.kind, name);
        const items = z.array(z.unknown()).min(1).max(size).parse(data.items);
        if (i < rows.length - 1 && items.length !== size) throw new TypeError('Incomplete theme chunk'); permitted.add(r.id); return items;
      });
    }
    const groups = chunks('groups', 32), mappings = z.array(z.object({ sourceThemeId: z.string(), groupId: z.string() }).strict()).parse(chunks('mappings', 128));
    labels = z.array(MarketThemeLabelSchema).parse(chunks('labels', 128)); decisions = z.array(MarketThemeDecisionSchema).parse(chunks('decisions', 128));
    if (snapshot.records.some(r => !permitted.has(r.id))) throw new TypeError('Unrecognized theme artifact record');
    const perAsin = selection.map(asin => snapshot.records.find(r => r.id === `asin:${asin}`)?.data as unknown as CustomerThemesAsinSummary);
    aggregation = restoreMarketThemeAggregate(saved,perAsin,groups,mappings);
    const members = aggregation.perAsin.flatMap(a => a.themes).map(t => t.sourceThemeId).sort();
    same(decisions.map(d => d.sourceThemeId).sort(), members);
    const semantics = obj(summary.semantics), unknown = decisions.filter(d => d.status === 'unknown').map(d => d.sourceThemeId).sort(),
      unavailable = decisions.filter(d => d.status === 'unavailable').map(d => d.sourceThemeId).sort();
    same(semantics.expectedMemberCount, members.length); same(semantics.validatedMemberCount, members.length - unavailable.length);
    same(semantics.mappedMemberCount, mappings.length); same(semantics.unknownMemberIds, unknown); same(semantics.unavailableMemberIds, unavailable);
    same(decisions.filter(d => d.status === 'mapped').map(d => ({ sourceThemeId: d.sourceThemeId, groupId: d.groupId })).sort((a, b) => a.sourceThemeId.localeCompare(b.sourceThemeId)),
      [...mappings].sort((a, b) => a.sourceThemeId.localeCompare(b.sourceThemeId)));
    if (decisions.some(d => d.status !== 'mapped' && d.groupId !== null)) throw new TypeError('Unmapped decision claims a group');
    const groupIds = [...new Set(mappings.map(m => m.groupId))].sort(); same(labels.map(l => l.groupId).sort(), groupIds);
  }
  return { aggregation, labels, decisions };
}
export function readMarketThemeDetailPage(snapshot: MarketInputSnapshot, value: unknown, emptySelection = false, priorEvaluations:readonly MarketInputSnapshot[]=[]) {
  const query = MarketThemeDetailQuerySchema.parse(value);
  const { aggregation, labels, decisions } = restoreMarketThemeDetails(snapshot, emptySelection,priorEvaluations);
  const labelMap = new Map(labels.map(l => [l.groupId, l])), decisionMap = new Map(decisions.map(d => [d.sourceThemeId, d]));
  let members = aggregation.perAsin.flatMap(a => a.themes);
  if (query.groupIndex !== undefined) {
    const group = aggregation.groups[query.groupIndex]; if (!group) throw new MarketThemeDetailQueryError();
    const wanted = new Set(group.members.map(m => m.sourceThemeId)); members = members.filter(m => wanted.has(m.sourceThemeId));
  }
  const rows = query.section === 'groups' ? aggregation.groups.map((g, index) => { const label = g.groupId ? labelMap.get(g.groupId) : null;
    return { kind: 'group' as const, index, groupId: g.groupId, mappingStatus: g.mappingStatus, labelZh: label?.labelZh ?? null, definition: label?.definition ?? null,
      labelOrigin: label?.origin ?? null, sourceLabel: g.mappingStatus === 'unmapped' ? preview(g.members[0].keyword) : null, memberCount: g.members.length, totals: g.totals, topicShare: g.topicShare }; })
    : query.section === 'asins' ? aggregation.perAsin.map(a => ({ kind: 'asin' as const, asin: a.asin, status: a.status, reason: a.reason,
      sourceRecordId: a.source?.sourceRecordId ?? null, fetchedAt: a.source?.fetchedAt ?? null, totals: a.totals, memberCount: a.themes.length }))
      : members.map(t => ({ kind: 'member' as const, sourceThemeId: t.sourceThemeId, asin: t.asin, sourceRecordId: t.sourceRecordId, sourceUpdatedAt: t.sourceUpdatedAt,
        keyword: preview(t.keyword), content: preview(t.content), mention: t.mention, positive: t.positive, negative: t.negative,
        withinAsinShare: t.topicShare, decision: decisionMap.get(t.sourceThemeId)! }));
  if (query.offset > rows.length) throw new MarketThemeDetailQueryError();
  const items: typeof rows[number][] = []; let bytes = 0;
  for (const row of rows.slice(query.offset, query.offset + query.limit)) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8'); if (bytes + size > 200000 && items.length) break;
    items.push(row); bytes += size;
  }
  return MarketThemeDetailPageSchema.parse({ section: query.section, offset: query.offset, limit: query.limit, totalItems: rows.length,
    nextOffset: query.offset + items.length < rows.length ? query.offset + items.length : null, groupIndex: query.groupIndex ?? null,
    metricKind: aggregation.metricKind, reviewDeduplication: 'unavailable', sentimentOverlap: aggregation.sentimentOverlap,
    totals: aggregation.totals, display: aggregation.display, items });
}
