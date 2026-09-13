import type { MarketAnalysisScope, MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import type { MarketKeywordTrendData } from '../../../shared/market-keyword-source-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, type MarketSourceEvidence } from '../../../shared/market-source-contracts';
import type { ConnectorResult } from '../../connectors/connector-contract';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { collectMarketKeywordTrend } from '../../services/market-keyword-collector';
import { createMarketInputSnapshot } from './snapshot';

function same(actual: unknown, expected: unknown): void {
  if (digest(actual) !== digest(expected)) throw new TypeError('Keyword trend evidence differs from its frozen source');
}

/** Verify persisted evidence using the collector against an in-memory JSON replay.
 * No database, connector credentials, external requests or current cache are used. */
export async function readMarketKeywordTrendEvidence(input: {
  scope: MarketAnalysisScope;
  snapshot: MarketInputSnapshot;
  sourceRef: string;
  source: MarketSourceEvidence;
  keyword: string;
}): Promise<MarketKeywordTrendData> {
  const { scope, snapshot: s, sourceRef, source, keyword } = input;
  same(scope, s.scope);
  same(scope, source.scope);
  if (s.kind !== 'keywords' || s.sourceVersion !== MARKET_SOURCE_HANDLER_VERSION || s.ruleVersion !== 'source-normalization/v1')
    throw new TypeError('Unsupported keyword trend snapshot');
  if (sourceRef !== `market-source:${digest(source)}` || source.provider !== 'sorftime' || source.operation !== 'keyword_trend' || source.requestIdentity.keyword !== keyword)
    throw new TypeError('Keyword trend source identity is unavailable');
  if (s.collectedAt !== source.fetchedAt) throw new TypeError('Keyword trend collection cutoff differs');
  const cutoff = new Date(source.fetchedAt);
  same(s, createMarketInputSnapshot({ scope: s.scope, kind: s.kind, sourceVersion: s.sourceVersion, ruleVersion: s.ruleVersion,
    collectedAt: s.collectedAt, expectedRecordIds: s.expectedRecordIds, records: s.records }, cutoff));
  const result = await collectMarketKeywordTrend({ scope, keyword, jobId: 'keyword-trend-source-replay', connector: {
    id: 'sorftime',
    probe: async () => { throw new Error('No probe in source replay'); },
    execute: async () => ({ data: structuredClone(source.payload) as ConnectorResult['data'],
      source: { connectorId: 'sorftime', operation: 'keyword_trend', fetchedAt: source.fetchedAt, attemptCount: 1 } }),
  } }, cutoff);
  if (result.status === 'failed') throw new TypeError('Stored keyword trend source is invalid');
  // Rebuilding evidence validates payload hashes, response identity paths and
  // statuses, request identity, coverage, observation period and unit metadata.
  same(result.evidence, source);
  same(s.expectedRecordIds, [result.memberId]);
  const { evidence: _evidence, issues: _issues, ...trend } = result;
  void _evidence;
  void _issues;
  same(s.records, [{ id: result.memberId, scope, data: { collection: 'keyword-trend', trend, sourceRef } }]);
  return result;
}
