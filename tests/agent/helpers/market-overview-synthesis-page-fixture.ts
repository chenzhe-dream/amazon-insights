import {overviewAnalysisDetails} from './market-overview-page-fixture';
export function synthesisDetails(){
 const detail=overviewAnalysisDetails(),semantic=detail.semantic!;
 if(semantic.task!=='market-overview-explanation')throw Error('overview required');
 const factId=semantic.facts[0].factId,metricId=semantic.metrics[0].metricId;
 const group={gapGroupId:'group:period',dimensionId:'sample',reason:'period-incompatible' as const,sourceRefs:semantic.gaps[0].sourceRefs,fieldKind:'response-scope',scopeKey:'2026-08',memberCount:1,originalGapIds:['period-missing']};
 const statement={parts:[{kind:'text' as const,text:'来源月份仍待确认'}],factIds:[factId],gapGroupIds:[group.gapGroupId]};
 const data={...statement,parts:[{kind:'fact-label' as const,factId},{kind:'text' as const,text:'为'},{kind:'metric' as const,metricId}]};
 const result={mode:'final' as const,summary:{decision:'insufficient-evidence' as const,statement:data},conflicts:[statement],limitations:[statement],verification:[statement]};
 const source=detail.entry.report;
 const report={...source,reportVersion:'market-overview-report/v2',windowStatus:'complete',reasons:[],synthesis:{status:'complete',result,dimensionChildren:[{childId:'dimension:sample',leafSectionIds:['leaf:sample'],section:{dimensionId:'sample',data,meaning:statement,conclusion:statement,limitations:[statement],verification:[statement]}}],gapGroups:[group],provenance:{sourceReportAttemptId:detail.entry.attemptId,sourceReportHash:source.reportHash,roundAttemptId:'70000000-0000-4000-8000-000000000014',modelAttemptId:'70000000-0000-4000-8000-000000000015',inputSnapshotId:'market-input:'+'f'.repeat(64),agentRunId:'70000000-0000-4000-8000-000000000016',basisId:'overview-basis:fixture'}}};
 return {...detail,entry:{...detail.entry,attemptId:'70000000-0000-4000-8000-000000000020',report}};
}
