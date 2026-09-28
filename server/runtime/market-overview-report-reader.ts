import {projectMarketOverviewOriginalSynthesis} from '../domain/market-research/overview-original-synthesis';
import {readOverviewIndustryDemand} from './market-overview-industry-demand-step';
import {z} from 'zod';
import {MarketSemanticRecordSchema} from '../../shared/market-semantic-contracts';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {PostgresMarketAgentRunStore} from '../db/postgres/market-agent-run-store';
import type {MarketModuleRunView,MarketStepDefinition} from '../db/market-module-execution-repository';
import {MarketOverviewReportInputSchema,marketOverviewReportDefinition} from '../domain/market-research/overview-report-plan';
import {MarketOverviewWindowPlanSchema,marketOverviewWindowPreparations} from '../domain/market-research/overview-window-plan';
import {restoreMarketOverviewSemanticWindow} from '../domain/market-research/overview-semantic-windows';
import {validateMarketOverviewExplanation} from '../domain/market-research/semantic-validation';
import {readMarketOverviewCatalog} from './market-overview-catalog-step';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import type {MarketOverviewAnalysis} from '../../shared/market-overview-analysis-contracts';
import {MarketRuleBaselineSchema} from '../../shared/market-rule-baseline-contracts';
import {projectMarketOverviewOriginalFields} from '../domain/market-research/overview-original-fields';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function same(a:unknown,b:unknown){if(digest(a)!==digest(b))throw new TypeError('Overview report frozen evidence differs');}
function invalid():never{throw new TypeError('Overview report frozen evidence is unavailable');}

/** Replay only declared immutable attempts, not whichever attempt is now latest.
 * This is shared by settlement and history reads, and never invokes providers. */
export async function readMarketOverviewReport(context:PostgresQueryContext,view:MarketModuleRunView,definition:MarketStepDefinition,signal:AbortSignal){
  signal.throwIfAborted();const input=MarketOverviewReportInputSchema.parse(definition.input);
  same({stepKey:definition.stepKey,kind:definition.kind,subject:definition.subject,input:definition.input,inputRefs:definition.inputRefs},marketOverviewReportDefinition(view,input));
  if(view.run.moduleKind!=='overview'||!['market-overview-flow/v2','market-overview-flow/v3','market-overview-flow/v4','market-overview-flow/v5','market-overview-flow/rules-v1','market-overview-flow/rules-v2','market-overview-flow/rules-v3'].includes(String(obj(view.run.params).flow)))invalid();
  const {catalog,sources,output:catalogOutput}=await readMarketOverviewCatalog(context,view,input.catalogAttemptId,signal,'frozen');same(input.numericInputSnapshotId,catalog.numericSnapshot.snapshotId);
  const industryDemand=input.industryDemandAttemptId?await readOverviewIndustryDemand(context,view,input.catalogAttemptId,input.industryDemandAttemptId,signal,sources):undefined;
  const full=catalog.semanticSnapshot,actor={organizationId:view.run.scope.organizationId,userId:view.run.createdBy},scope={actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id};
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),audits=new PostgresMarketAgentRunStore(context);
  const terminal=(id:string)=>{const a=view.attempts.find(a=>a.id===id),s=view.steps.find(s=>s.id===a?.stepId);if(!a||!s||!['succeeded','empty','failed','interrupted'].includes(a.status))invalid();return {a,s};};
  const modelResults:Array<{attemptId:string;bindingId:string;status:'succeeded'|'failed'|'empty';errorCode:string|null;agentRunId:string|null;output:ReturnType<typeof validateMarketOverviewExplanation>|null}>=[];
  const failures:Array<{attemptId:string;stage:'planning'|'preparation';errorCode:string}>=[];
  const synthesisWindows:Array<{inputSnapshotId:string;attemptId:string;agentRunId:string;analysis:MarketOverviewAnalysis}>=[];
  let synthesisPlan:ReturnType<typeof MarketOverviewWindowPlanSchema.parse>|null=null;
  let expectedWindowCount=0,rejectedCount=0;
  if(input.phase==='window-results'){
    const {a:window,s:windowStep}=terminal(input.windowAttemptId!);
    if(windowStep.kind!=='prepare-members'||obj(windowStep.input).phase!=='overview-semantic-windows'||obj(windowStep.input).catalogAttemptId!==input.catalogAttemptId||!full)invalid();
    same(windowStep.inputRefs,[{kind:'step-output',id:input.catalogAttemptId},{kind:'input',id:full.snapshotId},{kind:'input',id:catalog.numericSnapshot.snapshotId}]);
    if(['failed','interrupted'].includes(window.status)){
      if(input.preparationAttemptIds.length||input.modelAttemptIds.length)invalid();
      failures.push({attemptId:window.id,stage:'planning',errorCode:String(obj(window.error).code??'internal')});
    }else{
      const plan=MarketOverviewWindowPlanSchema.parse(window.output),semantic=MarketSemanticRecordSchema.parse(obj(full.records[0].data).semantic);
      synthesisPlan=plan;
      if(semantic.task!=='market-overview-explanation')invalid();
      same([plan.catalogAttemptId,plan.basisSnapshotId,plan.numericInputSnapshotId,plan.dataCutoffAt,plan.configurationVersion],[input.catalogAttemptId,full.snapshotId,catalog.numericSnapshot.snapshotId,full.collectedAt,view.run.versions.configuration]);
      const expected=[...semantic.facts.map(f=>`fact:${f.factId}`),...semantic.gaps.map(g=>`gap:${g.gapId}`)].sort();
      const assigned=[...plan.windows.flatMap(w=>[...w.primaryFactIds.map(id=>`fact:${id}`),...w.gapIds.map(id=>`gap:${id}`)]),...plan.rejected.map(r=>`${r.kind}:${r.id}`)].sort();same(assigned,expected);
      if(new Set(plan.windows.map(w=>w.inputSnapshotId)).size!==plan.windows.length)invalid();
      expectedWindowCount=plan.windows.length;rejectedCount=plan.rejected.length;
      const definitions=marketOverviewWindowPreparations(plan);if(input.preparationAttemptIds.length!==definitions.length)invalid();
      // The batch reader authorizes and verifies every binding, sharing only its
      // immutable source snapshots within one run/actor-locked transaction.
      const bindingIds=input.modelAttemptIds.map(id=>{const {s}=terminal(id);if(s.kind!=='model-batch')invalid();return z.string().uuid().parse(obj(s.input).bindingId);});
      const loadedBindings=bindingIds.length?await audits.findOverviewWindowBindings({...scope,bindingIds},signal):null;
      const bindingsById=new Map(loadedBindings?.bindings.map(binding=>[binding.id,binding]));
      const modelIds:string[]=[];
      for(let i=0;i<definitions.length;i++){
        signal.throwIfAborted();const w=plan.windows[i],{a:prepared,s:preparation}=terminal(input.preparationAttemptIds[i]);
        same(preparation.inputHash,digest(definitions[i]));
        const rebuilt=restoreMarketOverviewSemanticWindow(full,[...w.primaryFactIds.map(id=>({kind:'fact' as const,id})),...w.gapIds.map(id=>({kind:'gap' as const,id}))]);same(rebuilt.snapshot.snapshotId,w.inputSnapshotId);
        const saved=await snapshots.findInput({actor,studyId:scope.studyId,id:w.inputSnapshotId});if(!saved)invalid();same(saved.snapshot,rebuilt.snapshot);
        if(['failed','interrupted'].includes(prepared.status)){failures.push({attemptId:prepared.id,stage:'preparation',errorCode:String(obj(prepared.error).code??'internal')});continue;}
        const manifest=obj(prepared.output),batches=z.array(z.object({bindingId:z.string().uuid(),inputDigest:z.string()})).max(2000).parse(manifest.batches);
        if(batches.length!==1||z.array(z.unknown()).parse(manifest.rejectedMembers).length||z.array(z.unknown()).parse(manifest.missingMemberIds).length){failures.push({attemptId:prepared.id,stage:'preparation',errorCode:'incomplete-window-preparation'});}
        for(const batch of batches){
          const matches=input.modelAttemptIds.map(terminal).filter(({s})=>s.kind==='model-batch'&&obj(s.input).bindingId===batch.bindingId&&obj(s.input).inputDigest===batch.inputDigest);if(matches.length!==1)invalid();
          const {a,s}=matches[0];modelIds.push(a.id);
          const binding=bindingsById.get(batch.bindingId);
          if(!binding)invalid();same([binding.inputSnapshotId,binding.inputDigest,binding.selectionRevision,binding.dataCutoffAt],[w.inputSnapshotId,batch.inputDigest,plan.selectionRevision,plan.dataCutoffAt]);
          if(a.status!=='succeeded'){modelResults.push({attemptId:a.id,bindingId:batch.bindingId,status:a.status==='empty'?'empty':'failed',errorCode:String(obj(a.error).code??'no-model-result'),agentRunId:null,output:null});continue;}
          const receipt=obj(a.output),audit=await audits.findAgentRun({...scope,agentRunId:z.string().uuid().parse(receipt.agentRunId)});
          if(!audit||audit.attemptId!==a.id||audit.stepId!==s.id||audit.bindingId!==batch.bindingId||audit.executionFingerprint!==receipt.executionFingerprint||audit.task!=='market-overview-explanation'||audit.terminalStatus!=='succeeded'||audit.validationStatus!=='passed'||!audit.outcome?.output)invalid();
          same(receipt,{agentRunId:audit.id,bindingId:audit.bindingId,task:audit.task,executionFingerprint:audit.executionFingerprint});
          const sources:Record<string,NonNullable<Awaited<ReturnType<typeof snapshots.findSource>>>['evidence']>={};
          for(const ref of binding.sourceRefs){signal.throwIfAborted();const source=loadedBindings?.sourceEvidenceByRef[ref];if(!source)invalid();sources[ref]=source;}
          const output=validateMarketOverviewExplanation(binding.inputProjection,audit.outcome.output,{scope:view.run.scope,inputSnapshot:saved.snapshot,sourceEvidenceByRef:sources,
            selectionRevision:binding.selectionRevision,batchKey:binding.batchKey,inputDigest:binding.inputDigest,expectedIds:binding.memberRefs,sourceCatalog:Object.fromEntries(saved.snapshot.records.map(r=>[r.id,MarketSemanticRecordSchema.parse(obj(r.data).semantic)]))});
          modelResults.push({attemptId:a.id,bindingId:binding.id,status:'succeeded',errorCode:null,agentRunId:audit.id,output});
          if(output.analysis)synthesisWindows.push({inputSnapshotId:w.inputSnapshotId,attemptId:a.id,agentRunId:audit.id,analysis:output.analysis});
        }
      }
      same([...modelIds].sort(),[...input.modelAttemptIds].sort());
    }
  }
  const latest=catalog.months.at(-1)!,coverage=[
    {dimension:'sample-scale',metrics:['sampleProducts','totalUnits','totalRevenue']},
    {dimension:'concentration',metrics:['productConcentrationRaw','brandConcentrationRaw','sellerConcentrationRaw']},
    {dimension:'brand-seller-counts',metrics:['brands','sellers']},
    {dimension:'new-product-summary',metrics:['newCount','newAvgPrice','newAvgUnits']},
    {dimension:'rating-price-averages',metrics:['avgRatings','avgRating','avgPrice']},
  ].map(d=>{const metrics=d.metrics as Array<keyof typeof latest.metrics>,available=metrics.filter(m=>latest.metrics[m].state==='known');return {dimension:d.dimension,status:available.length===metrics.length?'available' as const:available.length?'partial' as const:'missing' as const,availableMetrics:available,missingMetrics:metrics.filter(m=>!available.includes(m))};});
  const semantic=full?MarketSemanticRecordSchema.parse(obj(full.records[0].data).semantic):null;
  const trends=semantic?.task==='market-overview-explanation'?semantic.facts.filter(f=>f.kind==='trend').flatMap(f=>f.metricRefs.filter(id=>id.endsWith('ChangePct'))):[];
  const trendMetrics=[`${latest.month}/totalUnitsChangePct`,`${latest.month}/totalRevenueChangePct`];
  const trendCoverage={dimension:'reported-sample-sales-trend',status:trends.length===2?'available' as const:trends.length?'partial' as const:'missing' as const,availableMetrics:trends,missingMetrics:trendMetrics.filter(id=>!trends.includes(id))};
  const missingDimensions=['search-demand','brand-share-distribution','seller-share-distribution','seller-type-distribution','seller-location-distribution','content-aplus-video-distribution','listing-age-distribution','listing-trend','review-count-distribution','rating-distribution','price-distribution'];
  const distributions='distributions' in catalog?catalog.distributions:null;
  const distributionDimensions:Record<string,string>={market_product_demand_trend:'search-demand',market_product_concentration:'product-share-distribution',market_brand_concentration:'brand-share-distribution',market_seller_concentration:'seller-share-distribution',market_seller_type_concentration:'seller-type-distribution',market_seller_country_distribution:'seller-location-distribution',market_ebc_distribution:'content-aplus-video-distribution',market_listing_date_distribution:'listing-age-distribution',market_listing_trend_distribution:'listing-trend',market_ratings_count_distribution:'review-count-distribution',market_rating_distribution:'rating-distribution',market_price_distribution:'price-distribution'};
  const distributionCoverage=distributions?.filter(d=>d.month===latest.month).map(d=>({dimension:distributionDimensions[d.operation],
    status:d.status==='ready'?'available' as const:d.status==='partial'?'partial' as const:'missing' as const,
    availableMetrics:d.distribution?.groups.filter(g=>g.products!==null||g.units!==null).map(g=>`${d.operation}/${g.id}`)??[],
    missingMetrics:d.issues.map(i=>i.code)}));
  const dataReady=catalog.months.some(m=>Object.values(m.metrics).some(v=>v.state==='known'))||!!distributions?.some(d=>d.distribution?.rows.some(r=>r.products!==null||r.units!==null));
  const rulesOnly=['market-overview-flow/rules-v1','market-overview-flow/rules-v2','market-overview-flow/rules-v3'].includes(String(obj(view.run.params).flow));
  const windowStatus=!full?'no-input' as const:rulesOnly?'complete' as const:input.phase==='numeric'?'pending' as const:!failures.length&&!rejectedCount&&expectedWindowCount>0&&modelResults.length===expectedWindowCount&&modelResults.every(r=>r.status==='succeeded')?'complete' as const:'partial' as const;
  const ruleBaseline='ruleBaseline' in obj(catalogOutput)?MarketRuleBaselineSchema.parse(obj(catalogOutput).ruleBaseline):undefined;
  const report={reportVersion:'market-overview-report/v1' as const,moduleRunId:view.run.id,scope:view.run.scope,versions:view.run.versions,...input,dataCutoffAt:catalog.numericSnapshot.collectedAt,
    sourceRefs:industryDemand?[...new Set([...catalog.sourceRefs,...(obj(view.attempts.find(a=>a.id===input.industryDemandAttemptId)?.output).sourceRefs as string[]??[])])]:catalog.sourceRefs,dataReady,analysisStatus:dataReady?'partial' as const:'no-data' as const,windowStatus,expectedWindowCount,rejectedCount,modelResults,failures,
    coverage:[...coverage,trendCoverage,...(distributionCoverage??missingDimensions.map(dimension=>({dimension,status:'not-integrated' as const,availableMetrics:[],missingMetrics:[]})))],
    reasons:[...(!dataReady?['no-numeric-data']:[]),...(windowStatus!=='complete'?[`explanation-${windowStatus}`]:[]),...(distributions?['distribution-synthesis-not-integrated']:['full-overview-dimensions-not-integrated']),...(rulesOnly?[]:['cross-window-synthesis-not-integrated'])],
    ...(rulesOnly?{ruleStatus:ruleBaseline?.status??(dataReady?'partial':'unavailable'),semanticStatus:'skipped' as const,...(ruleBaseline?{ruleBaseline}: {})}:{}),};
  // Internal evidence only: public details continue to select numbers/semantic.
  // A consumer must require complete windows and replay the complete manifest
  // before promoting these audited sections to a synthesis input.
  return {report:{...report,reportHash:digest(report)},numbers:{...(rulesOnly?{originalSynthesis:projectMarketOverviewOriginalSynthesis({scope:view.run.scope,parameters:catalog.parameters,sources,industryDemand})}:{}),...(industryDemand?{industryDemand}:{}),months:catalog.months,trendGaps:catalog.trendGaps,...(distributions?{distributions}:{}),originalSummary:projectMarketOverviewOriginalFields({scope:view.run.scope,parameters:catalog.parameters,sources})},semantic,
    synthesisSource:full&&synthesisPlan?{catalog:full,plan:synthesisPlan,windows:synthesisWindows}:null};
}
