import { z } from 'zod';
import type { MarketJsonValue, MarketInputSnapshot } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, type MarketSourceEvidence } from '../../shared/market-source-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { assembleMarketKeywordPool, MARKET_KEYWORD_POOL_VERSION, MarketKeywordPageIdentitySchema, MarketKeywordPoolCatalogSchema } from '../domain/market-research/keyword-source-pool';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler, MarketStepWork } from './market-module-step-worker';

const snapshotId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
export const MarketKeywordPoolStepInputSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('assemble'), plannedPages: z.array(MarketKeywordPageIdentitySchema).min(1).max(100), maxMembers: z.number().int().min(1).max(2000),
    pages: z.array(z.object({ inputSnapshotId: snapshotId, sourceRef: z.string().regex(/^market-source:[a-f0-9]{64}$/) }).strict()).max(100),
    catalog: MarketKeywordPoolCatalogSchema, selectionRevision: z.string().min(1).max(160), dataCutoffAt: z.string().datetime() }).strict(),
  z.object({ phase: z.literal('dispatch-trends'), inputSnapshotId: snapshotId, basisHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
function invalid(): never { throw new z.ZodError([{ code: 'custom', path: [], message: 'Keyword pool execution binding is unavailable' }]); }
const factory = (s: MarketInputSnapshot): MarketJsonValue => JSON.parse(JSON.stringify({ scope: s.scope, kind: s.kind, sourceVersion: s.sourceVersion,
  ruleVersion: s.ruleVersion, collectedAt: s.collectedAt, expectedRecordIds: s.expectedRecordIds, records: s.records }));

/** Pool publication and follow-up preparation are atomic. A separate bounded
 * fanout permits the full 2,000-member contract without a 2,001-child commit. */
export function createMarketKeywordPoolStep(context: PostgresQueryContext): MarketStepHandler {
  const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  return async ({ claim, signal }): Promise<MarketStepWork> => {
    signal.throwIfAborted(); const input = MarketKeywordPoolStepInputSchema.parse(claim.step.input);
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy }, view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId });
    const step = view?.steps.find(s => s.id === claim.stepId);
    if (!view || !step || claim.step.kind !== 'prepare-keyword-pool' || step.status !== 'running' || step.latestAttemptId !== claim.attemptId ||
      digest(claim.step) !== claim.inputHash || step.inputHash !== claim.inputHash || view.run.createdBy !== claim.createdBy ||
      view.run.scope.researchId !== claim.studyId || view.run.moduleKind !== 'keywords' || view.run.status === 'cancelled' ||
      view.run.versions.source !== MARKET_SOURCE_HANDLER_VERSION) invalid();
    const versions = view.run.versions;
    const hasModel = versions.model === 'market.semantic.text.v1' && Boolean(versions.configuration) && Boolean(versions.prompt);
    const noModel = versions.model === null && versions.configuration === null && versions.prompt === null;
    if (!hasModel && !noModel) invalid();
    async function bound(id: string) {
      signal.throwIfAborted(); if (!claim.step.inputRefs.some(r => r.kind === 'input' && r.id === id)) invalid();
      const saved = await snapshots.findInput({ actor, studyId: claim.studyId, id });
      if (!saved || digest(saved.snapshot.scope) !== digest(view!.run.scope)) invalid(); return saved.snapshot;
    }
    if (input.phase === 'dispatch-trends') {
      const snapshot = await bound(input.inputSnapshotId);
      if (snapshot.kind !== 'keywords' || snapshot.ruleVersion !== `${MARKET_KEYWORD_POOL_VERSION}:${input.basisHash}` || snapshot.sourceVersion !== MARKET_SOURCE_HANDLER_VERSION) invalid();
      // Require this run's successful pool receipt, not merely a caller-created input.
      const parent = view.attempts.find(a => ['succeeded', 'empty'].includes(a.status) &&
        (a.output as { rawInputSnapshotId?: string })?.rawInputSnapshotId === input.inputSnapshotId &&
        (a.output as { basisHash?: string })?.basisHash === input.basisHash && claim.step.inputRefs.some(r => r.kind === 'step-output' && r.id === a.id));
      if (!parent) invalid();
      return { kind: 'settlement', value: { outcome: { status: snapshot.records.length ? 'succeeded' : 'empty', output: { poolInputSnapshotId: snapshot.snapshotId, scheduledKeywordIds: snapshot.records.map(r => r.id) } },
        children: snapshot.records.map(r => {
          const data = r.data as { collection: string; member: { id: string; keyword: string } };
          if (data.collection !== 'keyword-page' || data.member.id !== r.id) invalid();
          return { stepKey: `trend/${digest({ pool: snapshot.snapshotId, keywordId: r.id })}`, kind: 'collect-keyword-trend', subject: { keywordId: r.id },
            input: { keywordId: r.id, keyword: data.member.keyword, poolInputSnapshotId: snapshot.snapshotId }, inputRefs: [{ kind: 'input', id: snapshot.snapshotId }] };
        }) } };
    }
    if (view.run.versions.mapping !== input.catalog.dictionaryVersion) invalid();
    const pages = [], sources: Record<string, MarketSourceEvidence> = {};
    for (const page of input.pages) {
      const snapshot = await bound(page.inputSnapshotId);
      if (!claim.step.inputRefs.some(r => r.kind === 'source' && r.id === page.sourceRef)) invalid();
      signal.throwIfAborted(); const saved = await snapshots.findSource({ actor, studyId: claim.studyId, id: page.sourceRef });
      if (!saved) invalid(); sources[page.sourceRef] = saved.evidence; pages.push({ snapshot, sourceRef: page.sourceRef });
    }
    const pool = assembleMarketKeywordPool({ ...input, scope: view.run.scope, pages, sources }); signal.throwIfAborted();
    const { rawSnapshot, semanticSnapshot, manifest } = pool;
    return { kind: 'settlement', value: { outcome: { status: rawSnapshot.records.length ? 'succeeded' : 'empty', output: manifest },
      inputs: [factory(rawSnapshot), factory(semanticSnapshot)], children: rawSnapshot.records.length ? [
        { stepKey: `pool-trends/${manifest.basisHash}`, kind: 'prepare-keyword-pool', subject: {},
          input: { phase: 'dispatch-trends', inputSnapshotId: rawSnapshot.snapshotId, basisHash: manifest.basisHash },
          inputRefs: [{ kind: 'input', id: rawSnapshot.snapshotId }, { kind: 'step-output', id: claim.attemptId }] },
        ...(hasModel ? [{ stepKey: `pool-model/${manifest.basisHash}`, kind: 'prepare-model-batches' as const, subject: { task: input.catalog.task },
          input: { task: input.catalog.task, inputSnapshotId: semanticSnapshot.snapshotId, selectionRevision: input.selectionRevision, dataCutoffAt: input.dataCutoffAt },
          inputRefs: [{ kind: 'input' as const, id: semanticSnapshot.snapshotId }] }] : []),
      ] : [] } };
  };
}
