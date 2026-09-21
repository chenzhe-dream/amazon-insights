import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import * as contracts from '../../shared/market-semantic-contracts';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { createMarketSourceEvidence } from '../../server/domain/market-research/source-evidence';
import { validateMarketKeywordSemantics } from '../../server/domain/market-research/semantic-validation';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';

// Synthetic protocol fixtures verify source binding and admissibility, not model quality.
const scope = { organizationId: 'test-org', researchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', marketplace: 'US' as const,
  nodeIdPath: '1:2', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
const date = '2026-09-01T00:00:00.000Z';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const schemaDigest = (schema: z.ZodType) => {
  const bytes = JSON.stringify(z.toJSONSchema(schema));
  return [createHash('sha256').update(bytes).digest('hex'), Buffer.byteLength(bytes)] as const;
};
const unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] } as const;
const span = (refId: string, quote: string, start = 0) => ({ refId, start, end: start + quote.length, quote });

function fixture(discoveryMode?: 'labels-and-clusters/v1', existingLabelId?: string) {
  const source = createMarketSourceEvidence({ scope, provider: 'sorftime', operation: 'synthetic_test', requestIdentity: { marketplace: 'US' },
    responseIdentityPaths: { marketplace: [['marketplace']] }, payload: { marketplace: 'US', synthetic: true }, fetchedAt: date,
    observationPeriod: { kind: 'calendar-months', fromMonth: '2026-07', toMonth: '2026-08' }, units: {},
    coverage: { receivedCount: 2, expectedCount: 2, truncation: { status: 'not-truncated' } } });
  const task = 'market-keyword-semantics' as const;
  const catalog = { dictionaryVersion: 'keywords/v1', categoryContext: 'Synthetic lighting category',
    dimensionLabels: { W1: [], W2: existingLabelId ? [{ labelId: existingLabelId, label: 'Existing', definition: 'Existing label' }] : [], W3: [], W4: [] },
    clusterCatalog: [], ...(discoveryMode ? { discoveryMode } : {}) };
  const keywords = [
    { keywordId: 'k1', text: { refId: 'text-k1', sourceRef: 'source', recordId: 'k1', field: 'keyword' as const, text: 'battery camping lantern' } },
    { keywordId: 'k2', text: { refId: 'text-k2', sourceRef: 'source', recordId: 'k2', field: 'keyword' as const, text: 'desk reading lamp' } },
  ];
  const records = keywords.map(keyword => ({ id: keyword.keywordId, scope, data: { semantic: { task, ...catalog, keyword } } }));
  const inputSnapshot = createMarketInputSnapshot({ scope, kind: 'keywords', sourceVersion: 'synthetic/v1', ruleVersion: 'semantic/v1',
    collectedAt: date, expectedRecordIds: keywords.map(k => k.keywordId), records });
  const { organizationId: _organizationId, ...publicScope } = scope;
  const projection = { schemaVersion: '1.0.0', task, batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scopeDigest: canonicalJsonSha256(scope),
    scope: publicScope, contentSnapshotId: inputSnapshot.snapshotId, selectionRevision: 'selection/v1', batchKey: 'batch-1', dataCutoffAt: date,
    sourceRefs: ['source'], ...catalog, keywords };
  const input = { ...projection, inputDigest: canonicalJsonSha256(projection) };
  const binding = { scope, inputSnapshot, sourceEvidenceByRef: { source }, selectionRevision: input.selectionRevision, batchKey: input.batchKey,
    inputDigest: input.inputDigest, expectedIds: keywords.map(k => k.keywordId), sourceCatalog: Object.fromEntries(records.map(r => [r.id, r.data.semantic])) };
  const output = { schemaVersion: '1.0.0', task, batchId: input.batchId, inputDigest: input.inputDigest,
    keywords: [
      { keywordId: 'k1', W1: { status: 'supported', labelIds: ['w1-portable'], evidence: [span('text-k1', 'camping', 8)] }, W2: unknown, W3: unknown,
        W4: { status: 'supported', labelIds: ['w4-battery'], evidence: [span('text-k1', 'battery')] }, cluster: unknown },
      { keywordId: 'k2', W1: unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown },
    ], proposals: [], synonymRelations: [], labelProposals: [
      { dimension: 'W1', labelId: 'w1-portable', label: 'Portable use', definition: 'Explicit portable or outdoor use intent', evidence: [span('text-k1', 'camping', 8)] },
      { dimension: 'W4', labelId: 'w4-battery', label: 'Battery powered', definition: 'Explicit battery power requirement', evidence: [span('text-k1', 'battery')] },
    ] };
  return { input, output, binding };
}

function reject(f: ReturnType<typeof fixture>, code: string) {
  assert.throws(() => validateMarketKeywordSemantics(f.input, f.output, f.binding),
    (error: unknown) => error instanceof z.ZodError && error.issues.some(issue => issue.message === code));
}

test('legacy keyword schema JSON bytes remain identical to the pre-discovery runtime identity', () => {
  assert.deepEqual(schemaDigest(contracts.MarketKeywordSemanticsLegacyInputSchema), ['38fd3a836c09a2b564ae4f2cb20f78d94f0129b53c68c4adce16f7423bc56284', 4934]);
  assert.deepEqual(schemaDigest(contracts.MarketKeywordSemanticsLegacyOutputSchema), ['a56411e4fc55c3740eb41a352900456944decfb860f2e95163944daf77576de0', 10328]);
});

test('discovery accepts source-grounded W1 and W4 labels while leaving W2 and W3 unknown', () => {
  const f = fixture('labels-and-clusters/v1');
  const result = validateMarketKeywordSemantics(f.input, f.output, f.binding);
  assert.deepEqual(result.labelProposals, f.output.labelProposals);
  assert.equal(result.keywords[0].W2.status, 'unknown');
  assert.equal(result.keywords[0].W3.status, 'unknown');
});

test('legacy mode rejects labelProposals even when empty and discovery requires the array', () => {
  const legacy = fixture(); legacy.output.labelProposals = []; reject(legacy, 'label_proposals_not_allowed');
  const discovery = fixture('labels-and-clusters/v1'); delete (discovery.output as Partial<typeof discovery.output>).labelProposals;
  reject(discovery, 'invalid_schema');
});

test('discovery rejects duplicate, colliding, unknown, wrong-dimension, and unused proposal ids', () => {
  const duplicate = fixture('labels-and-clusters/v1'); duplicate.output.labelProposals.push(clone(duplicate.output.labelProposals[0])); reject(duplicate, 'duplicate_id');
  const collision = fixture('labels-and-clusters/v1', 'w1-portable'); reject(collision, 'label_id_collision');
  const unknownId = fixture('labels-and-clusters/v1'); (unknownId.output.keywords[0].W1 as { labelIds: string[] }).labelIds = ['missing']; reject(unknownId, 'unknown_label');
  const wrongDimension = fixture('labels-and-clusters/v1'); (wrongDimension.output.keywords[0].W1 as { labelIds: string[] }).labelIds = ['w4-battery']; reject(wrongDimension, 'wrong_dimension_label');
  const unused = fixture('labels-and-clusters/v1'); unused.output.keywords[0].W4 = clone(unknown); reject(unused, 'unused_label_proposal');
});

test('proposal evidence and each assignment stay on the owning keyword and exact source text', () => {
  const wrongOwner = fixture('labels-and-clusters/v1'); wrongOwner.output.labelProposals[0].evidence = [span('text-k2', 'desk')]; reject(wrongOwner, 'span_unknown_or_foreign_reference');
  const wrongAssignment = fixture('labels-and-clusters/v1'); (wrongAssignment.output.keywords[0].W1 as { evidence: ReturnType<typeof span>[] }).evidence = [span('text-k2', 'desk')]; reject(wrongAssignment, 'span_unknown_or_foreign_reference');
  const wrongQuote = fixture('labels-and-clusters/v1'); wrongQuote.output.labelProposals[0].evidence[0].quote = 'outdoor'; reject(wrongQuote, 'span_quote_mismatch');
});

