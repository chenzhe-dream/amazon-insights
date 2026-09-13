import { createMarketThemeReport, MarketThemeReportStepInputSchema } from '../domain/market-research/customer-theme-report';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler } from './market-module-step-worker';
import { loadMarketThemeEvaluationHistory } from '../db/postgres/market-theme-evaluation-history';

export function createMarketThemeReportStep(context: PostgresQueryContext): MarketStepHandler {
  const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  return async ({ claim, signal }) => {
    signal.throwIfAborted(); const input = MarketThemeReportStepInputSchema.parse(claim.step.input);
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy };
    const view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId }), step = view?.steps.find(s => s.id === claim.stepId);
    if (!view || !step || step.status !== 'running' || step.latestAttemptId !== claim.attemptId || step.inputHash !== claim.inputHash ||
      digest(claim.step) !== claim.inputHash || view.run.createdBy !== actor.userId || view.run.scope.researchId !== claim.studyId || view.run.status === 'cancelled') throw new MarketExecutionConflictError();
    const saved = await snapshots.findInput({ actor, studyId: claim.studyId, id: input.inputSnapshotId });
    if (!saved) throw new MarketExecutionConflictError(); signal.throwIfAborted();
    const history=input.basis==='reconciliation-evaluation'?await loadMarketThemeEvaluationHistory(context,actor,view,input.evaluationAttemptId,saved.snapshot):[];
    const report = createMarketThemeReport(view, claim.step, saved.snapshot,history);
    return { kind: 'settlement', value: { outcome: { status: report.dataReady ? 'succeeded' : 'empty', output: report } } };
  };
}
