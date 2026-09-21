import { z } from 'zod';
import { MarketKeywordFactsSchema, MarketKeywordRunResponseSchema, type MarketKeywordFacts } from '../../shared/market-keyword-public-contracts';
import { MarketSemanticRecordSchema } from '../../shared/market-semantic-contracts';
import type { MarketSourceEvidence } from '../../shared/market-source-contracts';
import type { MarketKeywordPageMember } from '../../shared/market-keyword-source-contracts';
import { MarketExecutionConflictError, type MarketExecutionActor } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { isMarketKeywordFlow, inspectMarketKeywordContinuation, MarketKeywordFlowParamsSchema } from '../domain/market-research/keyword-flow';
import { assembleMarketKeywordPool } from '../domain/market-research/keyword-source-pool';
import { readMarketKeywordTrendEvidence } from '../domain/market-research/keyword-trend-evidence';
import {projectKeywordComparisonMonths} from '../domain/market-research/keyword-comparison-months';
import {readMarketKeywordAbaEvidence} from '../domain/market-research/keyword-aba-evidence';
import {MarketKeywordAbaMemberSchema} from '../../shared/market-keyword-aba-source-contracts';
import { validateMarketKeywordSemantics } from '../domain/market-research/semantic-validation';
import { canonicalJsonSha256 as digest } from '../runtime/model-request-accounting';
import { MarketKeywordPoolStepInputSchema } from '../runtime/market-keyword-pool-step';

const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function invalid(): never { throw new MarketExecutionConflictError(); }
function same(a: unknown, b: unknown) { if (digest(a) !== digest(b)) invalid(); }
const successful = (status: string) => status === 'succeeded' || status === 'empty';

/** Read-only, fixed-input recovery. No current configuration or network provider
 * is needed to validate an already stored semantic result. */
export async function readMarketKeywordRun(context: PostgresQueryContext, actor: MarketExecutionActor, id: string) {
  return context.transaction(async () => {
    await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE', [id, actor.organizationId]);
    const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context);
    const audits = new PostgresMarketAgentRunStore(context), view = await steps.findModuleRun({ actor, moduleRunId: id });
    if (!view || !isMarketKeywordFlow(view.run)) return null;
    const { flow: _flow, ...params } = MarketKeywordFlowParamsSchema.parse(view.run.params);
    void _flow;
    // Cancellation stops execution, not access to the last durable input/result.
    const current = new Set(inspectMarketKeywordContinuation(view, new Date().toISOString(), { readCancelled: true }).currentStepKeys);
    const readScope = { actor, studyId: view.run.scope.researchId, moduleRunId: id };
    const receipts = new Map((await context.query<{ id: string; receipt_json: unknown }>(
      'SELECT id,receipt_json FROM market_analysis_step_attempts WHERE organization_id=$1 AND run_id=$2', [actor.organizationId, id])).rows.map(r => [r.id, obj(r.receipt_json)]));
    function receipt(attemptId: string, inputIds: string[], sourceIds: string[] = []) {
      const saved = receipts.get(attemptId);
      const inputs = saved?.inputIds, sources = saved?.sourceIds;
      if (!saved || saved.attemptId !== attemptId || saved.status !== 'committed' || !Array.isArray(inputs) || !Array.isArray(sources)
        || inputIds.some(v => !inputs.includes(v)) || sourceIds.some(v => !sources.includes(v))) invalid();
    }
    let facts: MarketKeywordFacts | null = null;
    const poolStep = view.steps.find(s => current.has(s.stepKey) && s.kind === 'prepare-keyword-pool' && obj(s.input).phase === 'assemble' && successful(s.status));
    if (poolStep) {
      const poolAttempt = view.attempts.find(a => a.id === poolStep.latestAttemptId && a.stepId === poolStep.id);
      if (!poolAttempt || !successful(poolAttempt.status)) invalid();
      const input = MarketKeywordPoolStepInputSchema.parse(poolStep.input);
      if (input.phase !== 'assemble') invalid();
      const sources: Record<string, MarketSourceEvidence> = {}, pages = [];
      for (const page of input.pages) {
        const saved = await snapshots.findInput({ ...readScope, id: page.inputSnapshotId }), raw = await snapshots.findSource({ ...readScope, id: page.sourceRef });
        if (!saved || !raw) invalid();
        const owner = view.attempts.find(a => poolStep.inputRefs.some(r => r.kind === 'step-output' && r.id === a.id) && successful(a.status)
          && obj(a.output).inputSnapshotId === page.inputSnapshotId && obj(a.output).sourceRef === page.sourceRef);
        if (!owner) invalid();
        receipt(owner.id, [page.inputSnapshotId], [page.sourceRef]);
        pages.push({ snapshot: saved.snapshot, sourceRef: page.sourceRef }); sources[page.sourceRef] = raw.evidence;
      }
      const rebuilt = assembleMarketKeywordPool({ ...input, scope: view.run.scope, pages, sources });
      same(rebuilt.manifest, poolAttempt.output);
      const raw = await snapshots.findInput({ ...readScope, id: rebuilt.rawSnapshot.snapshotId });
      const semantic = await snapshots.findInput({ ...readScope, id: rebuilt.semanticSnapshot.snapshotId });
      if (!raw || !semantic) invalid();
      same(raw.snapshot, rebuilt.rawSnapshot); same(semantic.snapshot, rebuilt.semanticSnapshot);
      receipt(poolAttempt.id, [raw.snapshot.snapshotId, semantic.snapshot.snapshotId]);
      const abaById=new Map<string,NonNullable<MarketKeywordFacts['members'][number]['aba']>>();
      for(const step of view.steps.filter(s=>current.has(s.stepKey)&&s.kind==='collect-keyword-aba')){
        const input=z.object({members:z.array(z.object({keywordId:z.string(),keyword:z.string()})),referenceMonth:z.string()}).parse(step.input);
        const attempt=view.attempts.find(a=>a.id===step.latestAttemptId&&a.stepId===step.id);
        let base:Omit<NonNullable<MarketKeywordFacts['members'][number]['aba']>,'member'>={status:step.status==='failed'?(view.run.scope.marketplace!=='US'?'unsupported':'failed'):step.status==='cancelled'||view.run.status==='cancelled'?'cancelled':'pending',stepId:step.id,attemptId:attempt?.id??null,
          inputSnapshotId:null,sourceRef:null,fetchedAt:null,referenceMonth:input.referenceMonth,sourceScope:'exact-keyword-marketplace',nodeBinding:'not-provided'};
        let checked:ReturnType<typeof readMarketKeywordAbaEvidence>|undefined;
        if(successful(step.status)){
          if(!attempt||!successful(attempt.status))invalid();
          const out=obj(attempt.output),saved=await snapshots.findInput({...readScope,id:z.string().parse(out.inputSnapshotId)}),source=await snapshots.findSource({...readScope,id:z.string().parse(out.sourceRef)});
          if(!saved||!source)invalid();receipt(attempt.id,[saved.snapshot.snapshotId],[source.id]);
          checked=readMarketKeywordAbaEvidence({scope:view.run.scope,snapshot:saved.snapshot,sourceRef:source.id,source:source.evidence,members:input.members,referenceMonth:input.referenceMonth});
          same(out.collectionStatus,checked.status);same(out.referenceMonth,checked.referenceMonth);same(out.keywordIds,input.members.map(m=>m.keywordId));same(out.sourceVersion,checked.schemaVersion);
          base={...base,status:checked.status,inputSnapshotId:saved.snapshot.snapshotId,sourceRef:source.id,fetchedAt:source.evidence.fetchedAt};
        }
        for(const member of input.members){if(abaById.has(member.keywordId))invalid();
          const observed=checked?.members.find(m=>m.memberId===member.keywordId);if(checked&&!observed)invalid();
          abaById.set(member.keywordId,{...base,member:observed?MarketKeywordAbaMemberSchema.parse(observed):null});}
      }
      const members: MarketKeywordFacts['members'] = [];
      for (const record of raw.snapshot.records) {
        // The complete record has just been reconstructed from its source above.
        const data = obj(record.data), member = data.member as MarketKeywordPageMember;
        const trendStep = view.steps.find(s => current.has(s.stepKey) && s.kind === 'collect-keyword-trend' && obj(s.input).keywordId === record.id);
        const trendAttempt = trendStep ? view.attempts.find(a => a.id === trendStep.latestAttemptId && a.stepId === trendStep.id) : undefined;
        let trend: MarketKeywordFacts['members'][number]['trend'] = { status: trendStep?.status === 'failed' ? 'failed' : trendStep?.status === 'cancelled' || view.run.status === 'cancelled' ? 'cancelled' : 'pending',
          stepId: trendStep?.id ?? null, attemptId: trendAttempt?.id ?? null, inputSnapshotId: null, sourceRef: null, fetchedAt: null, cpcCurrency: null, months: [] };
        if (trendStep && successful(trendStep.status)) {
          if (!trendAttempt || !successful(trendAttempt.status)) invalid();
          const out = obj(trendAttempt.output);
          const saved = await snapshots.findInput({ ...readScope, id: z.string().parse(out.inputSnapshotId) });
          const source = await snapshots.findSource({ ...readScope, id: z.string().parse(out.sourceRef) });
          if (!saved || !source) invalid();
          receipt(trendAttempt.id, [saved.snapshot.snapshotId], [source.id]);
          const checked = await readMarketKeywordTrendEvidence({ scope: view.run.scope, snapshot: saved.snapshot, sourceRef: source.id, source: source.evidence, keyword: String(member.keyword) });
          same(out.keywordId, record.id); same(out.keyword, checked.keyword); same(out.collectionStatus, checked.status);
          trend = { status: checked.status, stepId: trendStep.id, attemptId: trendAttempt.id, inputSnapshotId: saved.snapshot.snapshotId,
            sourceRef: source.id, fetchedAt: source.evidence.fetchedAt, cpcCurrency: checked.cpcCurrency, months: [...checked.months],
            comparisonMonths:projectKeywordComparisonMonths(checked,view.run.scope.toMonth) };
        }
        const reference = trend.months.find(m => m.month === view.run.scope.toMonth);
        members.push({ keywordId: record.id, keyword: member.keyword, sourceRef: z.string().parse(data.sourceRef),
          ...(params.supplementalSources?{aba:abaById.get(record.id)??{status:view.run.status==='cancelled'?'cancelled':'pending',stepId:null,attemptId:null,inputSnapshotId:null,sourceRef:null,fetchedAt:null,referenceMonth:view.run.scope.toMonth,sourceScope:'exact-keyword-marketplace',nodeBinding:'not-provided',member:null}}:{}),
          occurrences: MarketKeywordFactsSchema.shape.members.element.shape.occurrences.parse(data.occurrences),
          pageMetrics: { monthlySearchVolume: member.monthlySearchVolume, weeklySearchVolume: member.weeklySearchVolume, weeklySearchRank: member.weeklySearchRank,
            recommendedCpcUsd: member.recommendedCpcUsd, period: 'unspecified-source-window' }, trend,
          reference: { searchVolume: reference?.searchVolume.value ?? null, yoyGrowth: reference?.yoyGrowth.value ?? null, recentGrowth: reference?.recentGrowth.value ?? null,
            actualCpcUsd: null, actualCpcReason: 'source-provides-recommended-bid-only' } });
      }
      const batches: MarketKeywordFacts['semantics']['batches'] = [];
      const modelSteps = view.steps.filter(s => current.has(s.stepKey) && s.kind === 'model-batch'&&s.inputRefs.some(r=>r.kind==='input'&&r.id===semantic.snapshot.snapshotId));
      for (const step of modelSteps.filter(s => s.status === 'succeeded')) {
        const attempt = view.attempts.find(a => a.id === step.latestAttemptId && a.stepId === step.id);
        if (!attempt || attempt.status !== 'succeeded') invalid();
        const output = obj(attempt.output), modelInput = obj(step.input);
        const audit = await audits.findAgentRun({ ...readScope, agentRunId: z.string().parse(output.agentRunId) });
        const binding = await audits.findSnapshotBinding({ ...readScope, bindingId: z.string().parse(modelInput.bindingId) });
        if (!audit || !binding || audit.task !== params.catalog.task || binding.task !== params.catalog.task || audit.attemptId !== attempt.id || audit.stepId !== step.id
          || audit.bindingId !== binding.id || output.bindingId !== binding.id || output.executionFingerprint !== audit.executionFingerprint
          || modelInput.inputDigest !== binding.inputDigest || binding.inputSnapshotId !== semantic.snapshot.snapshotId
          || binding.selectionRevision !== input.selectionRevision || binding.dataCutoffAt !== input.dataCutoffAt
          || audit.validationStatus !== 'passed' || audit.terminalStatus !== 'succeeded' || audit.dataCutoffAt !== binding.dataCutoffAt
          || !audit.snapshotIds.includes(binding.id)
          || audit.outcome?.terminalStatus !== 'succeeded' || audit.outcome.validationStatus !== 'passed' || !audit.outcome.output) invalid();
        for (const ref of binding.sourceRefs) if (!sources[ref]) invalid();
        const checked = validateMarketKeywordSemantics(binding.inputProjection, audit.outcome.output, { scope: view.run.scope, inputSnapshot: semantic.snapshot,
          sourceEvidenceByRef: sources, selectionRevision: binding.selectionRevision, batchKey: binding.batchKey, inputDigest: binding.inputDigest,
          expectedIds: binding.memberRefs, sourceCatalog: Object.fromEntries(semantic.snapshot.records.map(r => [r.id, MarketSemanticRecordSchema.parse(obj(r.data).semantic)])) });
        batches.push({ stepId: step.id, attemptId: attempt.id, agentRunId: audit.id, bindingId: binding.id, inputDigest: binding.inputDigest, output: checked });
      }
      const decisions = batches.flatMap(b => b.output.keywords), observed = new Set(decisions.map(k => k.keywordId));
      if (observed.size !== decisions.length || decisions.some(k => !members.some(m => m.keywordId === k.keywordId))) invalid();
      const unavailableKeywordIds = members.filter(m => !observed.has(m.keywordId)).map(m => m.keywordId);
      const pending = view.steps.some(s => current.has(s.stepKey) && s.inputRefs.some(r=>r.kind==='input'&&r.id===semantic.snapshot.snapshotId) && ['prepare-model-batches', 'model-batch'].includes(s.kind) && ['queued', 'running'].includes(s.status));
      const p = rebuilt.manifest;
      const value = { version: 'market-keyword-facts/v1' as const, moduleRunId: id, scope: view.run.scope, referenceMonth: view.run.scope.toMonth,
        pool: { attemptId: poolAttempt.id, rawInputSnapshotId: raw.snapshot.snapshotId, semanticInputSnapshotId: semantic.snapshot.snapshotId, basisHash: p.basisHash,
          dataCutoffAt: p.dataCutoffAt, plannedPageCount: p.plannedPageCount, receivedPageCount: p.receivedPageCount, missingPages: p.missingPages, emptyPages: p.emptyPages, fullPages: p.fullPages,
          collectionCoverage: p.collectionCoverage, exhaustive: p.exhaustive, maxMembers: p.maxMembers, uniqueObservedMemberCount: p.uniqueObservedMemberCount,
          omittedMemberIds: p.omittedMemberIds, conflictingMemberIds: p.conflictingMemberIds, duplicateMemberCount: p.duplicateMemberCount, memberLimitReached: p.memberLimitReached, selectionPolicy: p.selectionPolicy },
        members, semantics: { status: !view.run.versions.model ? 'unavailable' : pending ? 'pending' : members.length > 0 && !unavailableKeywordIds.length ? 'validated' : 'partial',
          batches, unavailableKeywordIds, unknownDimensionCount: decisions.reduce((sum, k) => sum + (['W1', 'W2', 'W3', 'W4'] as const).filter(d => k[d].status === 'unknown').length, 0),
          unknownClusterCount: decisions.filter(k => k.cluster.status === 'unknown').length } };
      facts = MarketKeywordFactsSchema.parse({ ...value, factsId: `market-keyword-facts:${digest(value)}` });
    }
    return MarketKeywordRunResponseSchema.parse({ run: { id, scope: view.run.scope, status: view.run.status, createdAt: view.run.createdAt, params, facts,
      steps: view.steps.map(s => { const a = view.attempts.find(a => a.id === s.latestAttemptId); return { id: s.id, kind: s.kind, status: s.status,
        latestAttemptId: s.latestAttemptId, attemptCount: s.attemptCount,nextAttemptAt:s.nextAttemptAt??null, current: current.has(s.stepKey), canRetry: current.has(s.stepKey) && s.status === 'failed' && view.run.status !== 'cancelled' && !(s.kind==='collect-keyword-aba'&&view.run.scope.marketplace!=='US'),
        asin: null, errorCode: ['failed', 'interrupted'].includes(a?.status ?? '') ? s.kind==='collect-keyword-aba'&&view.run.scope.marketplace!=='US'?'unsupported-marketplace':obj(a?.error).code ?? 'internal' : null }; }) } });
  });
}
