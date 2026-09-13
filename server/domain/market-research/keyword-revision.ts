import { z } from 'zod';
import { MarketKeywordFactsSchema, type MarketKeywordFacts } from '../../../shared/market-keyword-public-contracts';
import { MarketKeywordRevisionCatalogSchema, MarketKeywordRevisionRequestSchema } from '../../../shared/market-keyword-revision-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { aggregateKeywordClusters } from './keyword-clusters';
const dimensions = ['W1', 'W2', 'W3', 'W4'] as const;
function unique(ids: readonly string[], name: string) {
  if (new Set(ids).size !== ids.length) throw new TypeError(`Duplicate ${name}`);
  return new Set(ids);
}
/** Human classifications are separate from frozen source/model facts. No model
 * evidence, CPC or score is inferred. Always aggregate original reference metrics. */
export function buildMarketKeywordRevision(input: { facts: MarketKeywordFacts; request: unknown; authorId: string; createdAt: string }) {
  const facts = MarketKeywordFactsSchema.parse(input.facts), request = MarketKeywordRevisionRequestSchema.parse(input.request);
  const authorId = z.string().uuid().parse(input.authorId), createdAt = z.string().datetime().parse(input.createdAt);
  const { factsId, ...basis } = facts;
  if (factsId !== `market-keyword-facts:${digest(basis)}` || request.factsId !== factsId) throw new TypeError('Facts identity mismatch');
  const members = unique(facts.members.map(m => m.keywordId), 'facts member');
  const assigned = unique(request.assignments.map(a => a.keywordId), 'keyword assignment');
  if (members.size !== assigned.size || [...assigned].some(id => !members.has(id))) throw new TypeError('All original keywords must be assigned exactly once');
  const clusters = unique(request.clusters.map(c => c.clusterId), 'cluster');
  const labels = Object.fromEntries(dimensions.map(d => [d, unique(request.labels[d].map(l => l.labelId), `${d} label`)])) as Record<typeof dimensions[number], Set<string>>;
  for (const assignment of request.assignments) {
    if (assignment.clusterId !== null && !clusters.has(assignment.clusterId)) throw new TypeError('Unknown cluster');
    for (const dimension of dimensions) if (assignment[dimension].some(id => !labels[dimension].has(id))) throw new TypeError(`Unknown ${dimension} label`);
  }
  const version = 'market-keyword-revision/v1' as const;
  const revisionId = `market-keyword-revision:${digest({ version, authorId, createdAt, request, factsId })}`;
  return MarketKeywordRevisionCatalogSchema.parse({ version,
    revision: { revisionId, parentRevisionId: request.expectedParentRevisionId, authorId, createdAt, note: request.note }, facts,
    classification: { labels: request.labels, clusters: request.clusters, assignments: request.assignments },
    aggregation: aggregateKeywordClusters({ keywords: facts.members.map(m => ({ id: m.keywordId, text: m.keyword,
      searchVolume: m.reference.searchVolume, cpc: m.reference.actualCpcUsd, yoyGrowth: m.reference.yoyGrowth, recentGrowth: m.reference.recentGrowth })),
      mappings: request.assignments.flatMap(a => a.clusterId === null ? [] : [{ keywordId: a.keywordId, clusterId: a.clusterId }]) }),
  });
}
