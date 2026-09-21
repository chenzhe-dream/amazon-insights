import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import * as c from '../../shared/market-semantic-contracts';
import {SkillRegistry} from '../../server/skills/registry';
import {marketSemanticExecutionDefinition,marketSemanticOutputContract} from '../../server/skills/market-semantic-task-definitions';
import {marketSemanticWire} from '../../server/runtime/market-semantic-wire';
const digest=(s:z.ZodType)=>createHash('sha256').update(JSON.stringify(z.toJSONSchema(s))).digest('hex');
const fixture=async()=>JSON.parse(await readFile('skills-src/market-classify-keyword-demand-v1.1.0/fixtures/market-classify-keyword-demand-discovery-synthetic-v1.json','utf8'));
test('old keyword wire identities stay frozen apart from the supported marketplace expansion',()=>{
 // Only the two explicitly expanded country/currency fields may differ from
 // the US-only baseline; preserve the original hash check for every other field.
 const legacySiteDigest=(schema:z.ZodType)=>{
  const json=z.toJSONSchema(schema);
  const scope=(json.properties!.scope as {properties:Record<string,unknown>}).properties;
  scope.marketplace={type:'string',const:'US'};
  scope.currency={type:'string',const:'USD'};
  return createHash('sha256').update(JSON.stringify(json)).digest('hex');
 };
 assert.equal(legacySiteDigest(c.MarketKeywordSemanticsLegacyInputSchema),'38fd3a836c09a2b564ae4f2cb20f78d94f0129b53c68c4adce16f7423bc56284');
 assert.equal(legacySiteDigest(c.MarketKeywordSemanticsDiscoveryInputSchema),'7dd47d8906800943e4900345245f35121c7f528f067e00eb1ff93f8ee0cb251e');
 assert.equal(legacySiteDigest(c.MarketKeywordSemanticsReconciliationInputSchema),'c54627ac160fe209e6cb7877f60a1a656141387f5b60eb4675437b43b118fe06');
});
test('explicit shape selects immutable skill and keeps the same strict output contract',async()=>{
 const {input}=await fixture(), registry=await SkillRegistry.open('skills-src');
 for(const mode of ['discovery','reconciliation']){
  const old={...input};if(mode==='reconciliation'){delete old.discoveryMode;old.reconciliationDimension='W1';}
  const next={...old,outputProtocol:'explicit-shape/v1'}, version=mode==='discovery'?'1.3.0':'1.4.0';
  assert.ok(c.MarketKeywordSemanticsInputSchema.safeParse(next).success);
  const definition=marketSemanticExecutionDefinition(next),skill=await registry.load(definition.skill.id,definition.skill.version);
  assert.equal(definition.skill.version,version);assert.equal(skill.manifest.inputSchema,`MarketKeywordSemanticsInput@${version}`);assert.equal(skill.manifest.outputSchema,definition.outputSchema);
  assert.equal(digest(marketSemanticOutputContract(old).output),digest(marketSemanticOutputContract(next).output));
  assert.equal((marketSemanticWire(old).inputSchema as any).shape.outputProtocol,undefined);
  assert.ok((marketSemanticWire(next).inputSchema as any).shape.outputProtocol);
  assert.equal((marketSemanticWire(next).input as any).outputProtocol,'explicit-shape/v1');
  assert.equal(c.MarketKeywordSemanticsInputSchema.safeParse({...next,outputProtocol:'unversioned'}).success,false);
  const instructions=[skill.instructions,...skill.references.values()].join('\n');
  for(const token of ['keywordId,W1,W2,W3,W4,cluster','refId,start,end,quote','supported','unknown','schemaVersion,task,batchId,inputDigest,keywords,proposals,synonymRelations'])assert.ok(instructions.includes(token),token);
  assert.ok(!instructions.includes('Preserve scope, sources'));
 }
});
import {canonicalJsonSha256} from '../../server/runtime/model-request-accounting';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {validateMarketSemanticInput} from '../../server/domain/market-research/semantic-validation';
import {createStructuredResponseFormat} from '../../server/runtime/structured-response-format';

test('new synthetic fixtures have actual digests, strict shapes, compact instruction growth and bounded one-word requests',async(t)=>{
 const registry=await SkillRegistry.open('skills-src');
 for(const [version,oldVersion] of [['1.3.0','1.1.0'],['1.4.0','1.2.0']]){
  const skill=await registry.load('market-classify-keyword-demand',version),old=await registry.load('market-classify-keyword-demand',oldVersion);
  const f=JSON.parse(await readFile(`skills-src/market-classify-keyword-demand-v${version}/fixtures/${skill.manifest.fixtures[0]}.json`,'utf8'));
  const {inputDigest,...rest}=f.input;assert.equal(canonicalJsonSha256(rest),inputDigest);assert.equal(f.output.inputDigest,inputDigest);
  c.MarketKeywordSemanticsInputSchema.parse(f.input);marketSemanticOutputContract(f.input).output.parse(f.output);
  const size=(s:typeof skill)=>Buffer.byteLength([s.instructions,...s.references.values()].join('\n'));
  assert.ok(size(skill)<=size(old)+300,`${version}: ${size(skill)} > ${size(old)}+300`);
  const input={...f.input,keywords:structuredClone(f.input.keywords.slice(0,1))};
  const word=input.keywords[0], source='market-source:'+ 'a'.repeat(64);
  word.keywordId='kw_'+ 'b'.repeat(64);word.text.recordId=word.keywordId;word.text.refId='keyword-ref:'+ 'c'.repeat(64);word.text.sourceRef=source;word.text.text='synthetic lamp 1';
  input.sourceRefs=[source];input.selectionRevision='keyword-selection:'+ 'd'.repeat(64);input.batchKey='keyword-batch:'+ 'e'.repeat(64);
  const d=marketSemanticExecutionDefinition(input),o=marketSemanticOutputContract(input);
  const format=createStructuredResponseFormat<unknown>(o.output,d.outputSchema,o.schemaDefinitions).format;
  const instructions=[skill.instructions,...[...skill.references].map(([p,text])=>`\n# Reference: ${p}\n\n${text}`),'\nReturn only the declared structured output. Do not request tools or invoke agents.'].join('\n');
  const body={model:'gpt-5.6',messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify(marketSemanticWire(input).input)}],response_format:{type:'json_schema',json_schema:{name:format.name,strict:true,schema:format.schema}},reasoning_effort:'low',verbosity:'low',max_completion_tokens:4000};
  // Same byte-conservative +1024 framing/repair reserve as T17 sizing experiment; synthetic model/request only.
  const measured=Buffer.byteLength(JSON.stringify(body))+1024;
  t.diagnostic(`${version}: instructions ${size(skill)} bytes vs old ${size(old)}, one-word body plus reserve ${measured}/${d.budget.maxInputTokens}`);
  assert.ok(measured<=d.budget.maxInputTokens);
 }
});

test('explicit protocol remains bound to snapshot catalog and cannot activate legacy classification',async()=>{
 const original=(await fixture()).input;
 function bound(mode:boolean=true){
  const scope={organizationId:'test-org',...original.scope},date=original.dataCutoffAt;
  const source=createMarketSourceEvidence({scope,provider:'sorftime',operation:'synthetic_test',requestIdentity:{marketplace:'US'},responseIdentityPaths:{marketplace:[['marketplace']]},payload:{marketplace:'US',synthetic:true},fetchedAt:date,observationPeriod:{kind:'calendar-months',fromMonth:scope.fromMonth,toMonth:scope.toMonth},units:{},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}});
  const input:any=structuredClone(original);input.outputProtocol='explicit-shape/v1';if(!mode)delete input.discoveryMode;
  const {dictionaryVersion,categoryContext,dimensionLabels,clusterCatalog,discoveryMode,outputProtocol}=input;
  const catalog={dictionaryVersion,categoryContext,dimensionLabels,clusterCatalog,...(discoveryMode?{discoveryMode}:{}),outputProtocol};
  const records=input.keywords.map((keyword:any)=>({id:keyword.keywordId,scope,data:{semantic:{task:input.task,...catalog,keyword}}}));
  const snapshot=createMarketInputSnapshot({scope,kind:'keywords',sourceVersion:'synthetic/v1',ruleVersion:'semantic/v1',collectedAt:date,expectedRecordIds:records.map((r:any)=>r.id),records});
  input.contentSnapshotId=snapshot.snapshotId;input.scopeDigest=canonicalJsonSha256(scope);const {inputDigest,...rest}=input;input.inputDigest=canonicalJsonSha256(rest);
  const binding:any={scope,inputSnapshot:snapshot,sourceEvidenceByRef:Object.fromEntries(input.sourceRefs.map((ref:string)=>[ref,source])),selectionRevision:input.selectionRevision,batchKey:input.batchKey,inputDigest:input.inputDigest,expectedIds:records.map((r:any)=>r.id),sourceCatalog:Object.fromEntries(records.map((r:any)=>[r.id,r.data.semantic]))};
  return {input,binding};
 }
 const good=bound();assert.equal((validateMarketSemanticInput(good.input,good.binding) as any).outputProtocol,'explicit-shape/v1');
 const mismatch=bound();delete mismatch.binding.sourceCatalog[mismatch.binding.expectedIds[0]].outputProtocol;
 assert.throws(()=>validateMarketSemanticInput(mismatch.input,mismatch.binding));
 const legacy=bound(false);assert.throws(()=>validateMarketSemanticInput(legacy.input,legacy.binding),/explicit_keyword_mode_required/);
 assert.throws(()=>marketSemanticExecutionDefinition(legacy.input),/requires discovery or reconciliation/);
});
