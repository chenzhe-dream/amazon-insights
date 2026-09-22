import type {MarketModuleRunView} from '../../db/market-module-execution-repository';
import {MarketThemeReportSchema} from '../../../shared/market-module-contracts';
import {classifyMarketThemeReport} from './customer-theme-report';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';

/** Called after settlement under the run lock. Historical successes/failures are
 * retained, but only the currently published, complete report can finish a run. */
export function canCompleteMarketThemeRun(view:MarketModuleRunView,currentStepKeys:readonly string[]):boolean {
  if(view.run.moduleKind!=='customer-themes'||view.run.status==='cancelled'||!view.run.latestReportAttemptId||!currentStepKeys.length)return false;
  const current=currentStepKeys.map(key=>view.steps.find(s=>s.stepKey===key));
  if(current.some(s=>!s||!['succeeded','empty'].includes(s.status)))return false;
  const step=current.find(s=>s?.kind==='report'&&s.latestAttemptId===view.run.latestReportAttemptId);
  if(!step||step.status!=='succeeded')return false;
  const attempt=view.attempts.find(a=>a.id===step.latestAttemptId&&a.stepId===step.id);
  if(!attempt||attempt.status!=='succeeded')return false;
  const parsed=MarketThemeReportSchema.safeParse(attempt.output);if(!parsed.success)return false;
  const {reportHash,...report}=parsed.data;
  if(report.moduleRunId!==view.run.id||digest(report.scope)!==digest(view.run.scope)||digest(report.versions)!==digest(view.run.versions)||digest(report)!==reportHash)return false;
  const readiness=classifyMarketThemeReport(report.counts);
  const rulesOnly = report.versions.model === null && report.semanticStatus === 'skipped';
  const ruleStatus = report.ruleStatus ?? (report.status === 'complete' ? 'complete' : 'partial');
  return ruleStatus === 'complete' && report.dataReady && report.reasons.filter(reason => rulesOnly ? reason !== 'model-results-missing' && reason !== 'unknown-themes' : true).length === 0 && (rulesOnly || report.semanticsReady && readiness.status==='complete');
}
