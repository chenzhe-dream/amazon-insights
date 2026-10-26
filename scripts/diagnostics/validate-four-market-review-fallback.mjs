// Explicit candidate-only live review validation. Does not publish project snapshots.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const codeRoot=path.resolve(import.meta.dirname,'../..');
const candidateDb=new URL(process.env.AGENT_DATABASE_URL);
assert.equal(candidateDb.hostname,'127.0.0.1');
assert.equal(candidateDb.port,'64733');
assert.equal(candidateDb.pathname,'/amazon_de_ca_formalbase_20261021');
const base='C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime';
const evidenceRoot=process.env.REVIEW_FALLBACK_EVIDENCE_ROOT ?? path.join(base,'four-market-review-fallback-20261026',randomUUID());
assert.ok(path.resolve(evidenceRoot).startsWith(path.resolve(base,'four-market-review-fallback-20261026')+path.sep));
const cohorts={
  US:{project:'7e948748-e794-4322-ab19-c11d3bca328f',dir:'generated-app-data',asins:['B0G7BK6ZF6','B0F995MXGZ','B0GK1CBTWV','B0DR4T44Q2','B0FC69H9FB']},
  UK:{project:'5445a218-fc0e-4f29-a9e3-98c47679d873',dir:'generated-project-data/002b5ba6c76b8adc4d33a2633a6f80dc2ab2943d313a24bcace469314e37811f',asins:['B0FJ4T6V2C','B0F5NRLWB6','B0C6FP6LMY','B0FPXDD2D4','B0DQCF6ZVZ','B0DLB22T15','B0GHQW7GYY']},
  DE:{project:'0e6d9225-54b4-404f-b998-44a53f3f1e2a',dir:'generated-project-data/886ac30411504d0e35fdc893f56cc0650a09a0d490fa7735ac5f939c8686cdee',asins:['B09Q8MJP3R','B09GY72DX2','B09VP9LJQX','B0GCNJJDZP','B07KSDSSS1']},
  CA:{project:'39ff5c5c-8a96-4f00-99ca-0da1a4c029c6',dir:'generated-project-data/f98826058cd1faa0ba3e27e7a785051ae766533b57aa0a1104f560287a35a9c9',asins:['B0H79SDS1R','B0C3Z8F66G','B0G7BK6ZF6','B0GY49HWVP','B0H7BLV7JS']},
};
const marketplace=process.argv[2];
if(!marketplace){
  fs.mkdirSync(evidenceRoot,{recursive:true});
  for(const site of ['US','CA','DE','UK']) {
    const result=spawnSync(process.execPath,[import.meta.filename,site],{cwd:codeRoot,env:{...process.env,REVIEW_FALLBACK_EVIDENCE_ROOT:evidenceRoot},stdio:'inherit',timeout:600000});
    if(result.status!==0){console.error(JSON.stringify({site,status:result.status,error:result.error?.code}));process.exitCode=1;break;}
  }
  console.log(JSON.stringify({evidenceRoot}));
} else {
  const cohort=cohorts[marketplace];assert.ok(cohort);
  const jobId=randomUUID();
  Object.assign(process.env,{AGENT_FORMAL_WORKTREE_ROOT:codeRoot,AGENT_DATA_ROOT:path.join(evidenceRoot,marketplace,'data'),AGENT_RUNTIME_ROOT:path.join(evidenceRoot,marketplace,'runtime'),
    AGENT_SYNC_MARKETPLACE:marketplace,AGENT_SYNC_PROJECT_ID:cohort.project,AGENT_EXECUTION_ORGANIZATION_ID:'22222222-2222-4222-8222-222222222222',AGENT_SYNC_JOB_ID:jobId,AGENT_SYNC_STAGE_ID:'reviews',
    AGENT_SELLERSPRITE_REVIEW_FALLBACK:'1',AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED:'1',SORFTIME_SOURCE_CACHE_ENABLED:'0',SHARED_MCP_SOURCE_CACHE_ENABLED:'0'});
  process.chdir(codeRoot);
  const {readCachedDataExport}=await import('../lib/sync-cache.mjs');
  const {generatedAppDataPath}=await import('../lib/generated-app-data-path.mjs');
  const {selectReviewFallbackAsins,sellerSpriteReviewFallbackEnv}=await import('../lib/uk-review-fallback.mjs');
  const {runSellerSpriteReviewAnalysis}=await import('../build-sellersprite-review-analysis.mjs');
  const {fetchSellerSpriteReviews,callSellerSpriteMcpTool}=await import('../lib/sellersprite-mcp-client.mjs');
  const sourceDir=path.join(base,'data',cohort.dir);
  const sources=[['sorftime-review-analysis-data.ts','sorftimeReviewAnalysisData'],['seller-sprite-mcp-review-analysis-data.ts','sellerSpriteMcpReviewAnalysisData'],['sorftime-rating-data.ts','sorftimeRatingData']];
  const sourceHashes={};
  for(const [file,name] of sources){
    const original=path.join(sourceDir,file);
    sourceHashes[file]=fs.existsSync(original)?createHash('sha256').update(fs.readFileSync(original)).digest('hex'):null;
    const rows=readCachedDataExport(original,name);
    const selected=Object.fromEntries(cohort.asins.filter(asin=>rows[asin]?.marketplace===marketplace).map(asin=>[asin,rows[asin]]));
    const destination=generatedAppDataPath(codeRoot,file);
    // Keep candidate collection evidence when resuming a rate-limited validation.
    if(file!==sources[1][0] || !fs.existsSync(destination)) fs.writeFileSync(destination,`export const ${name} = ${JSON.stringify(selected)};\n`);
  }
  const primary=readCachedDataExport(generatedAppDataPath(codeRoot,sources[0][0]),sources[0][1]);
  const selected=selectReviewFallbackAsins(cohort.asins,primary,{marketplace,enabled:true});
  Object.assign(process.env,sellerSpriteReviewFallbackEnv(selected,marketplace));
  const calls=[];
  if(selected.length) await runSellerSpriteReviewAnalysis({asins:selected,wait:async()=>{},fetchReviews:(key,site,asin,options)=>fetchSellerSpriteReviews(key,site,asin,{...options,
    signal:AbortSignal.timeout(60000),timeoutMs:30000,
    callTool:async(secret,tool,args,opts)=>{
      const savedFile=path.join(evidenceRoot,`${marketplace}-${asin}-${args.page}.json`);
      const saved=fs.existsSync(savedFile)?JSON.parse(fs.readFileSync(savedFile,'utf8')):null;
      if(saved){assert.equal(saved.site,site);assert.equal(saved.asin,asin);assert.deepEqual(saved.args,args);return saved.payload;}
      let payload;
      for(let attempt=0;attempt<3;attempt++){
        try{payload=await callSellerSpriteMcpTool(secret,tool,args,{...opts,signal:AbortSignal.timeout(60000)});break;}
        catch(error){
          let admission=error;
          for(let depth=0;admission && admission.name!=='ResourceGovernorAdmissionError' && depth<8;depth++) admission=admission.cause;
          if(admission?.reason!=='rolling-window'||!admission.retryAt||attempt===2)throw error;
          const delay=Math.min(60000,Math.max(1000,Date.parse(admission.retryAt)-Date.now()+500));
          console.log(JSON.stringify({site,asin,waitingForCandidateRateWindowMs:delay}));
          await new Promise(resolve=>setTimeout(resolve,delay));
        }
      }
      const entry={site,asin,tool,args,payload};
      const raw=JSON.stringify(entry);assert.ok(!raw.includes(secret));
      calls.push({site,asin,page:args.page,code:payload.code,items:payload.data?.items?.length??null,total:payload.data?.total??null});
      fs.writeFileSync(savedFile,raw);
      return payload;
    }})});
  const collectionExit=process.exitCode??0;
  const {readAsinStatusSources,deriveAsinModuleStatus}=await import('../lib/asin-data-status.mjs');
  const {projectStageOutput}=await import('../lib/sync-stage-output.mjs');
  const statusSources=readAsinStatusSources(process.env);
  const ready=cohort.asins.filter(asin=>deriveAsinModuleStatus(asin,statusSources).reviews==='ready');
  const fallbackRows=readCachedDataExport(generatedAppDataPath(codeRoot,sources[1][0]),sources[1][1]);
  const failures=selected.filter(asin=>fallbackRows[asin]?.status==='error');
  const output=projectStageOutput('reviews',cohort.asins,{marketplace,sellerSpriteReviewFallback:true,stageStatus:ready.length===cohort.asins.length?'done':'partial',dataAsins:ready,
    gapItems:failures.map(asin=>({asin,causeCode:'CONNECTOR_FAILED'})),jobId,projectId:cohort.project});
  const outputFile=path.join(evidenceRoot,`${marketplace}-stage-output.json`);
  fs.writeFileSync(outputFile,JSON.stringify(output,null,2));assert.deepEqual(JSON.parse(fs.readFileSync(outputFile,'utf8')),output);
  for(const [file] of sources){const original=path.join(sourceDir,file);assert.equal(fs.existsSync(original)?createHash('sha256').update(fs.readFileSync(original)).digest('hex'):null,sourceHashes[file]);}
  const summary={marketplace,jobId,asins:cohort.asins.length,fallbackSelected:selected,ready:ready.length,collectionExit,calls,rows:cohort.asins.map(asin=>({asin,ready:ready.includes(asin),provider:statusSources.reviews[asin]?.sourceProvider??'Sorftime',samples:statusSources.reviews[asin]?.sampledReviews??null,fallbackStatus:fallbackRows[asin]?.status,reason:fallbackRows[asin]?.statusMessage})),outputFile,formalSourceHashesUnchanged:true};
  fs.writeFileSync(path.join(evidenceRoot,`${marketplace}-summary.json`),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
  // A provider gap is an observed outcome, not a harness failure. It remains in the summary.
  process.exitCode=0;
}
