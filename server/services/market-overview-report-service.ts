import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../db/market-module-execution-repository';
import {inspectMarketOverviewContinuation,isMarketOverviewFlow} from '../domain/market-research/overview-flow';
import {readMarketOverviewReport} from '../runtime/market-overview-report-reader';
import {readMarketOverviewSynthesisReport} from '../runtime/market-overview-synthesis-report-reader';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {MarketOverviewDetailsResponseSchema} from '../../shared/market-overview-report-contracts';

export class MarketOverviewReportService{
  constructor(private readonly context:PostgresQueryContext){}
  async details(input:{actor:MarketExecutionActor;moduleRunId:string;attemptId:string}){
    MarketModuleIdSchema.parse(input.moduleRunId);MarketModuleIdSchema.parse(input.attemptId);
    return this.context.transaction(async()=>{
      const validated=await this.readValidatedDetail({actor:input.actor,moduleRunId:input.moduleRunId},input.attemptId);
      if(!validated)return null;
      return MarketOverviewDetailsResponseSchema.parse({entry:validated.entry,numbers:validated.resolved.numbers,semantic:validated.resolved.semantic});
    });
  }
  async read(input:{actor:MarketExecutionActor;moduleRunId:string}){
    return this.context.transaction(async()=>(await this.readValidated(input))?.reports??null);
  }
  private async readValidatedDetail(input:{actor:MarketExecutionActor;moduleRunId:string},attemptId:string){
    const lock=await this.context.query(`SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2
      AND EXISTS(SELECT 1 FROM users WHERE id=$3 AND organization_id=$2 AND status='active') FOR SHARE`,[input.moduleRunId,input.actor.organizationId,input.actor.userId]);
    if(!lock.rowCount)return null;
    const view=await new PostgresMarketModuleExecutionStore(this.context).findModuleRun(input);if(!view||!isMarketOverviewFlow(view.run))return null;
    const attempt=view.attempts.find(value=>value.id===attemptId),step=view.steps.find(value=>value.id===attempt?.stepId);
    if(!attempt||!step||step.kind!=='report'||!['succeeded','empty'].includes(attempt.status)||(attempt.output as {superseded?:boolean})?.superseded)return null;
    const reader=(step.input as {phase?:string})?.phase==='overview-synthesis-report'?readMarketOverviewSynthesisReport:readMarketOverviewReport;
    const resolved=await reader(this.context,view,step,new AbortController().signal,input.actor),report=resolved.report;
    if(digest(report)!==digest(attempt.output))throw new MarketExecutionConflictError();
    const current=new Set(inspectMarketOverviewContinuation(view,new Date().toISOString()).currentStepKeys);
    return {entry:{attemptId:attempt.id,current:current.has(step.stepKey)&&step.latestAttemptId===attempt.id,report},resolved};
  }
  private async readValidated(input:{actor:MarketExecutionActor;moduleRunId:string},detailAttemptId?:string){
      let detail:Awaited<ReturnType<typeof readMarketOverviewReport>>|Awaited<ReturnType<typeof readMarketOverviewSynthesisReport>>|undefined;
      const lock=await this.context.query(`SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2
        AND EXISTS(SELECT 1 FROM users WHERE id=$3 AND organization_id=$2 AND status='active') FOR SHARE`,[input.moduleRunId,input.actor.organizationId,input.actor.userId]);
      if(!lock.rowCount)return null;
      const view=await new PostgresMarketModuleExecutionStore(this.context).findModuleRun(input);if(!view||!isMarketOverviewFlow(view.run))return null;
      const current=new Set(inspectMarketOverviewContinuation(view,new Date().toISOString()).currentStepKeys),history=[];
      for(const a of view.attempts){
        const step=view.steps.find(s=>s.id===a.stepId);if(!step||step.kind!=='report'||!['succeeded','empty'].includes(a.status)||(a.output as {superseded?:boolean})?.superseded)continue;
        const reader=(step.input as {phase?:string})?.phase==='overview-synthesis-report'?readMarketOverviewSynthesisReport:readMarketOverviewReport;
        const resolved=await reader(this.context,view,step,new AbortController().signal,input.actor),{report}=resolved;
        if(digest(report)!==digest(a.output))throw new MarketExecutionConflictError();
        if(a.id===detailAttemptId)detail=resolved;
        history.push({attemptId:a.id,current:current.has(step.stepKey)&&step.latestAttemptId===a.id,report});
      }
      const latestSavedReport=history.find(r=>r.attemptId===view.run.latestReportAttemptId)??null;
      if(view.run.latestReportAttemptId&&!latestSavedReport)throw new MarketExecutionConflictError();
      const currentReport=(latestSavedReport?.current&&('industryDemandAttemptId' in latestSavedReport.report||'externalAttemptIds' in latestSavedReport.report)?latestSavedReport:null)??history.find(r=>r.current&&('industryDemandAttemptId' in r.report||'externalAttemptIds' in r.report))??history.find(r=>r.current&&r.report.reportVersion==='market-overview-report/v2')??history.find(r=>r.current&&r.report.phase==='window-results')??history.find(r=>r.current&&r.report.phase==='numeric')??null;
      return {reports:{moduleRunId:view.run.id,currentReport,latestSavedReport,history},detail};
  }
}
