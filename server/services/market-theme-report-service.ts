import {marketSharedReadSql} from '../db/postgres/market-shared-read-sql';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { createMarketThemeReport, restoreMarketThemeReportEnvelope, MarketThemeReportStepInputSchema } from '../domain/market-research/customer-theme-report';
import { inspectMarketThemeContinuation, isMarketThemeFlow } from '../domain/market-research/customer-theme-flow';
import { readMarketThemeDetailPage } from '../domain/market-research/customer-theme-details';
import { MarketThemeDetailQuerySchema, MarketThemeDetailResponseSchema } from '../../shared/market-theme-detail-contracts';
import { MarketModuleIdSchema } from '../../shared/market-module-contracts';
import { MarketThemeEvidenceQuerySchema, MarketThemeEvidenceResponseSchema } from '../../shared/market-theme-evidence-contracts';
import { readMarketThemeEvidence } from './market-theme-evidence-reader';
import { loadMarketThemeEvaluationHistory } from '../db/postgres/market-theme-evaluation-history';

/** Read-only, organization scoped. Reports do not trigger collection or models.
 * Short shared run lock keeps the pointer, attempts and frontier from different
 * revisions being combined while another worker settles or retries a source. */
export class MarketThemeReportService {
  constructor(private readonly context: PostgresQueryContext) {}
  async readDetails(input: { actor: MarketExecutionActor; moduleRunId: string; attemptId: string; query: unknown }) {
    const query = MarketThemeDetailQuerySchema.parse(input.query);
    return this.context.transaction(async()=>{const resolved=await this.resolveReport(input);if(!resolved)return null;
      return MarketThemeDetailResponseSchema.parse({report:resolved.entry,page:readMarketThemeDetailPage(resolved.snapshot,query,resolved.entry.report.basis==='empty-selection',resolved.priorEvaluations)});});
  }
  async readEvidence(input: { actor: MarketExecutionActor; moduleRunId: string; attemptId: string; query: unknown }) {
    const query=MarketThemeEvidenceQuerySchema.parse(input.query);
    return this.context.transaction(async()=>{const resolved=await this.resolveReport(input);if(!resolved)return null;
      return MarketThemeEvidenceResponseSchema.parse({report:resolved.entry,evidence:await readMarketThemeEvidence(this.context,input.actor,resolved.view,resolved.snapshot,query.sourceThemeId,resolved.entry.report.basis==='empty-selection',resolved.priorEvaluations)});});
  }
  async resolveReport(input:{actor:MarketExecutionActor;moduleRunId:string;attemptId:string}) {
    const moduleRunId = MarketModuleIdSchema.parse(input.moduleRunId), attemptId = MarketModuleIdSchema.parse(input.attemptId);
    return this.context.transaction(async () => {
      const locked = await this.context.query(`SELECT id FROM market_analysis_module_runs r WHERE id=$1 AND organization_id=$2
        AND ${marketSharedReadSql('$3','r.organization_id',{run:'r.id'})} FOR SHARE`, [moduleRunId, input.actor.organizationId, input.actor.userId]);
      if (!locked.rowCount) return null;
      const view = await new PostgresMarketModuleExecutionStore(this.context).findModuleRun({ actor: input.actor, moduleRunId });
      if (!view || !isMarketThemeFlow(view.run)) return null;
      const attempt = view.attempts.find(a => a.id === attemptId), step = view.steps.find(s => s.id === attempt?.stepId);
      if (!attempt || !step || step.kind !== 'report' || !['succeeded', 'empty'].includes(attempt.status) || (attempt.output as { superseded?: boolean })?.superseded) return null;
      const definition = MarketThemeReportStepInputSchema.parse(step.input);
      const saved = await new PostgresMarketAnalysisSnapshotStore(this.context).findInput({ actor: input.actor, studyId: view.run.scope.researchId, id: definition.inputSnapshotId });
      if (!saved) throw new MarketExecutionConflictError();
      const priorEvaluations=definition.basis==='reconciliation-evaluation'?await loadMarketThemeEvaluationHistory(this.context,input.actor,view,definition.evaluationAttemptId,saved.snapshot):[];
      const report = restoreMarketThemeReportEnvelope(createMarketThemeReport(view, step, saved.snapshot,priorEvaluations),attempt.output);
      if (!report) throw new MarketExecutionConflictError();
      const current = inspectMarketThemeContinuation(view, new Date().toISOString()).currentStepKeys.includes(step.stepKey) && step.latestAttemptId === attemptId;
      return {entry:{attemptId,current,report},snapshot:saved.snapshot,view,priorEvaluations};
    });
  }
  async read(input: { actor: MarketExecutionActor; moduleRunId: string }) {
    return this.context.transaction(async () => {
      const locked = await this.context.query(`SELECT id FROM market_analysis_module_runs r WHERE id=$1 AND organization_id=$2
        AND ${marketSharedReadSql('$3','r.organization_id',{run:'r.id'})} FOR SHARE`,
      [input.moduleRunId, input.actor.organizationId, input.actor.userId]);
      if (!locked.rowCount) return null;
      const view = await new PostgresMarketModuleExecutionStore(this.context).findModuleRun(input);
      if (!view || !isMarketThemeFlow(view.run)) return null;
      const currentKeys = new Set(inspectMarketThemeContinuation(view, new Date().toISOString()).currentStepKeys);
      const snapshots = new PostgresMarketAnalysisSnapshotStore(this.context), reports = [];
      for (const attempt of view.attempts) {
        const step = view.steps.find(s => s.id === attempt.stepId);
        if (!step || step.kind !== 'report' || !['succeeded', 'empty'].includes(attempt.status) || (attempt.output as { superseded?: boolean })?.superseded) continue;
        const definition = MarketThemeReportStepInputSchema.parse(step.input);
        const saved = await snapshots.findInput({ actor: input.actor, studyId: view.run.scope.researchId, id: definition.inputSnapshotId });
        if (!saved) throw new MarketExecutionConflictError();
        const history=definition.basis==='reconciliation-evaluation'?await loadMarketThemeEvaluationHistory(this.context,input.actor,view,definition.evaluationAttemptId,saved.snapshot):[];
        const report = restoreMarketThemeReportEnvelope(createMarketThemeReport(view, step, saved.snapshot,history),attempt.output);
        if (!report) throw new MarketExecutionConflictError();
        reports.push({ attemptId: attempt.id, current: currentKeys.has(step.stepKey) && step.latestAttemptId === attempt.id, report });
      }
      const latestSaved = reports.find(r => r.attemptId === view.run.latestReportAttemptId) ?? null;
      if (view.run.latestReportAttemptId && !latestSaved) throw new MarketExecutionConflictError();
      return { moduleRunId: view.run.id, executionStatus: view.run.status, planRevision: view.run.planRevision,
        currentReport: latestSaved?.current ? latestSaved : null, latestSavedReport: latestSaved, history: reports };
    });
  }
}
