import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {openRuntimeAgentRepository} from '../../server/db/open-runtime-repository';import {loadAgentStorageConfig} from '../../server/config';
import {preprocessVocSnapshot} from '../../server/domain/voc/preprocess-voc-snapshot';
import {buildVocPositioningInput,canonicalizeVocPositioningOutput} from '../../server/domain/voc/voc-positioning-contracts';
import {createAmazonVocInsightOutputSchema} from '../../server/domain/voc/amazon-voc-insight-contracts';
import {compactVocResponseSchema,hydrateVocOutput} from '../../server/services/voc-compact-output';
assert.equal(new URL(process.env.AGENT_DATABASE_URL!).pathname,'/amazon_de_ca_formalbase_20261021');assert.equal(process.env.AGENT_SERVICE_PORT,'33901');
const root=path.resolve(process.env.AGENT_RUNTIME_ROOT!,'..'),capture=JSON.parse(fs.readFileSync(path.join(root,'evidence/private/DE-invalid-model.json'),'utf8'));
const repository=await openRuntimeAgentRepository(loadAgentStorageConfig());
try{const run=await repository.findAnalysisRun(capture.runId);assert.ok(run);const project=await repository.findProjectById(run.projectId);assert.ok(project);
 const snapshots=await repository.listDataSnapshotsByRun({actorOrganizationId:project.organizationId,runId:run.id});const snapshot=snapshots.at(-1)!;assert.ok(snapshot);
 const facts=preprocessVocSnapshot(snapshot),input=buildVocPositioningInput(facts);const text=capture.outputText.trimEnd();assert.equal(text.at(-1),'}');const parsed=JSON.parse(text.slice(0,-1));
 const compact=compactVocResponseSchema.safeParse(parsed);let full:any=null,hydrationIssues:unknown[]=[];
 try{const hydrated=hydrateVocOutput(parsed,facts) as Record<string,unknown>;const canonical={...hydrated,positioningProjection:canonicalizeVocPositioningOutput(hydrated.positioningProjection,facts)};full=createAmazonVocInsightOutputSchema(input).safeParse(canonical);}
 catch(error){hydrationIssues=(error as {issues?:Array<{path:unknown;code:unknown;message:string}>}).issues?.map(i=>({path:i.path,code:i.code,rule:i.message==='voc-forged-theme-reference'?i.message:'validation-error'}))??[{code:'validation-error'}];}
 const safe=(result:any)=>result?.success?[]:result?.error.issues.map((i:any)=>({path:i.path,code:i.code}))??[];
 const themes=new Set(facts.dimensions.flatMap(d=>d.themes.map(t=>JSON.stringify([d.key,t.key]))));const unknownRefs:string[]=[];
 const scan=(v:unknown,p:string)=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach((x,i)=>scan(x,`${p}[${i}]`));return;}const o=v as Record<string,unknown>;if(typeof o.dimension==='string'&&typeof o.themeKey==='string'&&!themes.has(JSON.stringify([o.dimension,o.themeKey])))unknownRefs.push(p);for(const [k,x] of Object.entries(o))scan(x,`${p}.${k}`);};scan(parsed.positioningProjection,'positioningProjection');
 const diagnostic={runId:run.id,snapshotId:snapshot.id,compactValid:compact.success,compactIssues:safe(compact),semanticValid:full?.success??false,semanticIssues:safe(full),hydrationIssues,unknownReferencePaths:unknownRefs};
 fs.writeFileSync(path.join(root,'evidence/DE-normalized-offline-validation.json'),JSON.stringify(diagnostic,null,2));console.log(JSON.stringify(diagnostic));
}finally{await repository.close();}
