import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const database=new URL(process.env.AGENT_DATABASE_URL??'');
assert.equal(database.pathname,'/amazon_de_ca_formalbase_20261021');
assert.equal(process.env.AGENT_SERVICE_PORT,'33901');
const root=path.resolve(process.env.AGENT_RUNTIME_ROOT!,'..');
const origin='http://192.168.1.109:33900';
const login=JSON.parse(fs.readFileSync(path.join(root,'qa-login.json'),'utf8'));
const response=await fetch(`${origin}/api/agent/v1/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:login.email,password:login.password})});
assert.equal(response.status,200,'Candidate QA login must succeed');
const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
assert.ok(cookie);
async function api(route:string,body?:unknown,headers:Record<string,string>={}){
 const res=await fetch(`${origin}/api/agent${route}`,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const payload=await res.json();
 if(!res.ok)throw new Error(`${route}: HTTP ${res.status} ${JSON.stringify(payload)}`);
 return payload;
}
type Entry={marketplace:'DE'|'CA';asins:string[];name:string;projectId?:string;slug?:string;jobId?:string;baseSyncRunId?:string;analysisRunId?:string};
const statePath=path.join(root,'evidence','live-run-state.json');
const entries:Entry[]=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):[
 {marketplace:'DE',asins:['B09Q8MJP3R','B09GY72DX2','B09VP9LJQX','B0GCNJJDZP','B07KSDSSS1'],name:'Playground Fitness Equipment DE Candidate'},
 {marketplace:'CA',asins:['B07DWKNXNY','B0GMYQ6B1X','B0D4M95CD7'],name:'Balance Boards CA Candidate'}
];
const save=()=>fs.writeFileSync(statePath,JSON.stringify(entries,null,2));
const mode=process.env.DE_CA_MODE??'status';
for(const entry of entries){
 if(mode==='start'&&!entry.jobId){
  if(!entry.projectId){
   const existing=await api('/v1/local-data/projects?kind=analysis');
   const project=existing.projects.find((p:any)=>p.marketplace===entry.marketplace&&p.asins.length===entry.asins.length&&entry.asins.every(asin=>p.asins.includes(asin)))??(await api('/v1/local-data/projects',{kind:'analysis',name:entry.name,alias:entry.name,marketplace:entry.marketplace,asins:entry.asins})).project;
   entry.projectId=project.id;entry.slug=project.slug;save();
  }
  const registered=await api('/v1/projects',{id:entry.projectId,name:entry.name,marketplace:entry.marketplace,asins:entry.asins},{'idempotency-key':`de-ca-acceptance:${entry.projectId}`});
  assert.equal(registered.project.marketplace,entry.marketplace);
  assert.deepEqual([...registered.project.asins].sort(),[...entry.asins].sort());
  const started=await api('/v1/local-data/sync-asins',{projectId:entry.projectId,marketplace:entry.marketplace,asins:entry.asins});
  entry.jobId=started.jobId;entry.baseSyncRunId=started.scope.runId;save();
  fs.writeFileSync(path.join(root,'evidence',`${entry.marketplace}-admission.json`),JSON.stringify(started,null,2));
  console.log(JSON.stringify({marketplace:entry.marketplace,projectId:entry.projectId,jobId:entry.jobId,runId:entry.baseSyncRunId,created:true}));
 }
 if(!entry.jobId)continue;
 const job=await api(`/v1/local-data/sync-asins/${entry.jobId}`);
 fs.writeFileSync(path.join(root,'evidence',`${entry.marketplace}-collection.json`),JSON.stringify(job,null,2));
 const observed=job.job??job;
 console.log(JSON.stringify({marketplace:entry.marketplace,jobId:entry.jobId,status:observed.status,stages:observed.stages?.map((stage:any)=>({id:stage.id,status:stage.status,detail:stage.detail,results:stage.results}))}));
 if(mode==='analyze'&&!entry.analysisRunId){
  const inventory=await api(`/v1/projects/${entry.projectId}/voc-inputs?baseSyncRunId=${entry.baseSyncRunId}&asins=${entry.asins.join(',')}`);
  fs.writeFileSync(path.join(root,'evidence',`${entry.marketplace}-inventory.json`),JSON.stringify(inventory,null,2));
  assert.equal(inventory.fallback.marketplace,entry.marketplace);
  assert.equal(inventory.fallback.sourceMode,'review-fallback','Must have real site-scoped review evidence');
  assert.deepEqual([...inventory.fallback.selectedAsins].sort(),[...entry.asins].sort());
  const analysis=await api(`/v1/projects/${entry.projectId}/runs`,{mode:'existing-data',idempotencyKey:`de-ca-analysis:${entry.jobId}`,evidenceSelection:{baseSyncRunId:entry.baseSyncRunId,selectedAsins:entry.asins,sourcePolicy:'manual-with-review-fallback',expectedInputFingerprint:inventory.fallback.fingerprint}});
  entry.analysisRunId=analysis.run.id;save();
  console.log(JSON.stringify({marketplace:entry.marketplace,analysisCreated:true,runId:entry.analysisRunId}));
 }
 if(entry.analysisRunId){
  const analysis=await api(`/v1/runs/${entry.analysisRunId}`);
  const reports=await api(`/v1/runs/${entry.analysisRunId}/reports`);
  fs.writeFileSync(path.join(root,'evidence',`${entry.marketplace}-analysis.json`),JSON.stringify({analysis,reports},null,2));
  console.log(JSON.stringify({marketplace:entry.marketplace,runId:entry.analysisRunId,status:analysis.run?.status,stages:analysis.stages?.map((stage:any)=>({stage:stage.stage,status:stage.status,lastError:stage.lastError})),reports:reports.reports?.map((report:any)=>({id:report.id,kind:report.kind,status:report.status}))}));
 }
}
