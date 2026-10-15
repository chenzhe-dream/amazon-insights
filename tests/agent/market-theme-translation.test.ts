import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { collectMarketProductPool } from '../../server/services/market-product-pool-collector';
import { collectMarketCustomerThemes } from '../../server/services/market-customer-themes-collector';
import { selectMarketThemeMembers } from '../../server/domain/market-research/customer-theme-source-pool';
import { calculateMarketThemeMappingRules } from '../../server/domain/market-research/customer-theme-mapping-rules';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { MarketThemeTranslationService } from '../../server/services/market-theme-translation';
import type { MarketExecutionActor } from '../../server/db/market-module-execution-repository';
import { marketThemeLanguage } from '../../shared/market-theme-translation-contracts';
import { fixedThemeTranslation } from '../../server/services/market-theme-translation-memory';

const at = '2026-09-01T00:00:00.000Z';
const asin = 'B000000001';

async function fixture() {
  const scope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  const pool = await collectMarketProductPool({ scope, month: '2026-08', poolSize: 1, newProductMonths: 6, jobId: 'translation-test', connector: {
    id: 'sellerSprite', probe: async () => { throw Error('unused'); }, execute: async request => ({ data: { code: 'OK', data: [{ asin, title: 'Test product' }] }, source: { connectorId: 'sellerSprite', operation: request.operation, fetchedAt: at, attemptCount: 1 } }),
  } });
  assert.ok(pool.evidence);
  const productRef = `market-source:${digest(pool.evidence)}`;
  const products = createMarketInputSnapshot({ scope, kind: 'products', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at, expectedRecordIds: [asin], records: pool.products.map(product => ({ id: product.asin, scope, data: { collection: 'product-month', month: '2026-08', product, sourceRef: productRef } })) });
  const selection = selectMarketThemeMembers({ snapshot: products, sources: { [productRef]: pool.evidence }, count: 1 });
  const theme = await collectMarketCustomerThemes({ scope, asin, jobId: 'translation-test', connector: {
    id: 'sorftime', probe: async () => { throw Error('unused'); }, execute: async request => ({ data: { data: { details: [{ keyword: 'Brightness', content: 'Not bright for 2 hours', mention: 2, positive: 0, negative: 2, update_time: '2026-08-01' }] } }, source: { connectorId: 'sorftime', operation: request.operation, fetchedAt: at, attemptCount: 1 } }),
  } });
  assert.ok(theme.evidence);
  const themeRef = `market-source:${digest(theme.evidence)}`;
  const observation = createMarketInputSnapshot({ scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at, expectedRecordIds: [asin], records: [{ id: asin, scope, data: { collection: 'customer-themes', result: theme.result, sourceRef: themeRef } }] });
  const rules = calculateMarketThemeMappingRules({
    poolInput: { selection: selection.snapshot, selectedAsins: [asin], catalog: { task: 'market-customer-theme-mapping', mappingVersion: 'mapping/v1', groupCatalog: [] }, dataCutoffAt: at, observations: [{ snapshot: observation, sourceRef: themeRef }], sources: { [productRef]: pool.evidence, [themeRef]: theme.evidence }, failures: [] },
    batches: [], originalRules: true,
  });
  const { aggregation: { groups: aggregateGroups, perAsin, mappings, ...aggregation }, groups: labels, decisions, ...summary } = rules;
  const chunks = (kind: string, items: unknown[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => ({ id: `${kind}:${index}`, data: { kind, items: items.slice(index * size, (index + 1) * size) } }));
  const records = [{ id: 'summary', data: { ...summary, artifactLayout: 'theme-rules-chunks/v1', aggregation } }, ...perAsin.map(item => ({ id: `asin:${item.asin}`, data: item })), ...chunks('groups', aggregateGroups, 32), ...chunks('mappings', mappings, 128), ...chunks('labels', labels, 128), ...chunks('decisions', decisions, 128)].map(record => ({ ...record, scope, data: MarketInputRecordSchema.shape.data.parse(record.data) }));
  const snapshot = createMarketInputSnapshot({ scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: `market-theme-mapping-rules/v1:${rules.resultHash}`, collectedAt: at, expectedRecordIds: records.map(record => record.id), records });
  const moduleRunId = randomUUID(), attemptId = randomUUID(), reportHash = 'a'.repeat(64);
  const entry = { attemptId, current: true, report: { reportVersion: 'market-theme-report/v3' as const, moduleRunId, scope, versions: { source: 'source/v1', rule: 'market-theme-flow/rules-v3', mapping: 'mapping/v1', planner: 'market-theme-flow/rules-v3', model: null, prompt: null, configuration: null }, basis: 'rules' as const, basisAttemptId: attemptId, inputSnapshotId: snapshot.snapshotId, resultHash: rules.resultHash, dataCutoffAt: at, categoryName: '测试类目', selectedAsins: [asin], selectionBasis: 'provider-row-order' as const, bsrTopVerified: false as const, metricKind: 'customers_say_topic_share' as const, reviewDeduplication: 'unavailable' as const, status: 'complete' as const, dataReady: true, semanticsReady: true, counts: { requestedCount: 1, selectedCount: 1, successfulCount: 1, emptyCount: 0, failedCount: 0, missingCount: 0, expectedMemberCount: 1, validatedMemberCount: 1, mappedMemberCount: 1, unknownCount: 0, unavailableCount: 0, reconciliationRequired: false }, reasons: [], reportHash, ruleStatus: 'complete' as const, semanticStatus: 'skipped' as const } };
  return { scope, moduleRunId, attemptId, entry, snapshot, actor: { organizationId: scope.organizationId, userId: randomUUID() } as MarketExecutionActor };
}

test('translation reads are free, failed text is retried alone, and ready text is reused', async () => {
  const f = await fixture();
  const root = mkdtempSync(join(process.env.TEMP ?? '.', 'market-theme-translation-'));
  try {
    let calls = 0, failContent = true;
    const service = new MarketThemeTranslationService({
      root, modelIdentity: 'test-model/v1',
      resolveReport: { resolveReport: async () => ({ entry: f.entry, snapshot: f.snapshot, view: {}, priorEvaluations: [] }) } as never,
      readSelection: async () => ({ samples: [{ asin, customerSay: { value: 'Customers find brightness low for 2 hours' } }] }),
      translate: async source => { calls += 1; assert.equal(source.language,'en-US'); if (source.item.field === 'member-content' && failContent) { failContent = false; throw new Error('provider timeout'); } return source.item.original.includes('2') ? 'Low brightness for 2 hours' : 'Brightness'; },
    });
    const initial = await service.read(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(initial); assert.equal(calls, 0); assert.ok(initial.items.every(item => item.state === (['group-label','member-keyword'].includes(item.field)?'ready':'missing')));
    const started = await service.start(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(started); await service.drain();
    const afterFailure = await service.read(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(afterFailure); const failed = afterFailure.items.filter(item => item.state === 'failed'); const ready = afterFailure.items.filter(item => item.state === 'ready');
    assert.equal(failed.length, 1); assert.ok(ready.length >= 1); const callsAfterFirstRun = calls;
    const retried = await service.start(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash, itemIds: failed.map(item => item.itemId) });
    assert.ok(retried); await service.drain();
    const final = await service.read(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(final); assert.equal(final.items.filter(item => item.state === 'failed').length, 0); assert.equal(calls, callsAfterFirstRun + 1); assert.equal(final.items.filter(item => item.state === 'ready').length, afterFailure.items.filter(item => item.state === 'ready').length + 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site language is report-bound, survives restart, isolates cached locales and preserves originals',async()=>{
 const f=await fixture(),root=mkdtempSync(join(process.env.TEMP??'.','market-theme-languages-'));
 try{
  const cases=[['US','en-US','Brightness'],['UK','en-GB','Brightness'],['CA','en-CA','Brightness'],['DE','de-DE','Helligkeit'],['FR','fr-FR','Luminosité'],['IT','it-IT','Luminosità'],['ES','es-ES','Luminosidad'],['JP','ja-JP','明るさ']] as const;
  let calls=0,language='en-US';
  const make=()=>new MarketThemeTranslationService({root,modelIdentity:'offline-fixture',resolveReport:{resolveReport:async()=>({entry:f.entry,snapshot:f.snapshot,priorEvaluations:[]})} as never,translate:async source=>{calls++;assert.equal(source.language,language);return cases.find(c=>c[1]===language)![2]+(source.item.original.includes('2')?' 2':'');}});
  const hashes=new Set<string>();
  for(const [site,locale] of cases){
   assert.equal(marketThemeLanguage(site).code,locale);language=locale;
   // Keep IDs/hash identical deliberately to prove target locale is part of cache identity.
   Object.assign(f.entry.report.scope,{marketplace:site,currency:site==='JP'?'JPY':site==='UK'?'GBP':site==='CA'?'CAD':site==='US'?'USD':'EUR'});
   const service=make(),query={reportHash:f.entry.report.reportHash};
   const before=await service.read(f.actor,f.moduleRunId,f.attemptId,query);
   assert.ok(before);assert.ok(before.items.every(i=>i.language===locale&&i.state===(['group-label','member-keyword'].includes(i.field)?'ready':'missing')));
   assert.ok(before.items.filter(i=>i.state==='ready').every(i=>i.translated===cases.find(c=>c[1]===locale)![2]));
   await service.start(f.actor,f.moduleRunId,f.attemptId,query);await service.drain();
   const count=calls,after=await make().read(f.actor,f.moduleRunId,f.attemptId,query);assert.ok(after);
   assert.ok(after.items.every(i=>i.state==='ready'&&i.language===locale));assert.deepEqual(after.items.map(i=>i.original),before.items.map(i=>i.original));
   assert.ok(!hashes.has(after.items[0].sourceHash));hashes.add(after.items[0].sourceHash);
   await make().start(f.actor,f.moduleRunId,f.attemptId,query);assert.equal(calls,count);
  }
  assert.throws(()=>marketThemeLanguage('XX'));
  assert.throws(()=>marketThemeLanguage('__proto__'));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('quota failure and altered numbers keep originals; duplicate submission and wrong report cannot dispatch extra work',async()=>{
 const f=await fixture(),root=mkdtempSync(join(process.env.TEMP??'.','market-theme-failures-'));
 try{
  let calls=0;
  const service=new MarketThemeTranslationService({root,modelIdentity:'offline-failures',resolveReport:{resolveReport:async()=>({entry:f.entry,snapshot:f.snapshot,priorEvaluations:[]})} as never,translate:async source=>{calls++;if(source.item.field==='member-content')return 'Brightness for 999 hours';throw Error('Synthetic quota exhausted');}});
  const query={reportHash:f.entry.report.reportHash};
  assert.equal(await service.start(f.actor,f.moduleRunId,f.attemptId,{reportHash:'b'.repeat(64)}),null);assert.equal(calls,0);
  const initial=await service.read(f.actor,f.moduleRunId,f.attemptId,query);assert.ok(initial);
  await Promise.all([service.start(f.actor,f.moduleRunId,f.attemptId,query),service.start(f.actor,f.moduleRunId,f.attemptId,query)]);await service.drain();
  const read=await service.read(f.actor,f.moduleRunId,f.attemptId,query);assert.ok(read);
  assert.equal(calls,initial.items.filter(i=>i.state==='missing').length);assert.ok(read.items.filter(i=>!['group-label','member-keyword'].includes(i.field)).every(i=>i.state==='failed'&&i.translated===null));
  assert.deepEqual(read.items.map(i=>i.original),initial.items.map(i=>i.original));
  assert.match(read.items.find(i=>i.field==='member-content')!.message!,/数字/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('fixed labels are local; concurrent reports and a restarted service reuse persisted translations', async () => {
 const a=await fixture(),b=await fixture(),root=mkdtempSync(join(process.env.TEMP??'.','theme-content-cache-'));
 try {
  let calls=0;
  const make=(modelIdentity='model-A')=>new MarketThemeTranslationService({root,modelIdentity,resolveReport:{resolveReport:async({moduleRunId}: {moduleRunId:string})=>{const f=moduleRunId===a.moduleRunId?a:b;return {entry:f.entry,snapshot:f.snapshot,priorEvaluations:[]};}} as never,translate:async source=>{calls++;assert.ok(['group-definition','member-content'].includes(source.item.field));return source.item.field==='member-content'?'Not bright for 2 hours':'Exact keyword grouping';}});
  const service=make(),q={reportHash:a.entry.report.reportHash};
  const initial=await service.read(a.actor,a.moduleRunId,a.attemptId,q);assert.ok(initial);
  assert.ok(initial.items.filter(i=>i.field==='member-keyword'||i.field==='group-label').every(i=>i.state==='ready'&&i.translated==='Brightness'));
  await Promise.all([service.start(a.actor,a.moduleRunId,a.attemptId,q),service.start(a.actor,b.moduleRunId,b.attemptId,q)]);await service.drain();
  assert.equal(calls,2,'each distinct non-glossary text across concurrent reports must use one model call');
  const restarted=make();
  const read=await restarted.read(a.actor,b.moduleRunId,b.attemptId,q);assert.ok(read);assert.ok(read.items.every(i=>i.state==='ready'));
  // A fresh report identity must read successful content from disk without calling a model.
  b.entry.report.reportHash='c'.repeat(64);
  const fresh=await restarted.read(a.actor,b.moduleRunId,b.attemptId,{reportHash:b.entry.report.reportHash});assert.ok(fresh);assert.ok(fresh.items.every(i=>i.state==='ready'));assert.equal(calls,2);
  assert.equal(await restarted.read(a.actor,b.moduleRunId,b.attemptId,{reportHash:'d'.repeat(64)}),null);
  const changedModel=make('model-B');await changedModel.start(a.actor,b.moduleRunId,b.attemptId,{reportHash:b.entry.report.reportHash});await changedModel.drain();assert.equal(calls,4);
  const isolated=await restarted.read(b.actor,b.moduleRunId,b.attemptId,{reportHash:b.entry.report.reportHash});assert.ok(isolated);assert.equal(isolated.items.find(i=>i.field==='member-content')!.state,'missing');
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('identical ASIN summaries are translated once; a changed source still needs translation', async()=>{
 const f=await fixture(),root=mkdtempSync(join(process.env.TEMP??'.','theme-summary-cache-'));
 try {
  let calls=0,summary='The lamp is not dimmable.';
  const make=()=>new MarketThemeTranslationService({root,modelIdentity:'summary-model',resolveReport:{resolveReport:async()=>({entry:f.entry,snapshot:f.snapshot,priorEvaluations:[]})} as never,readSelection:async()=>({samples:[{asin:'B000000001',customerSay:{value:summary}},{asin:'B000000002',customerSay:{value:summary}}]}),translate:async source=>{calls++;return source.item.original;}});
  const request={reportHash:f.entry.report.reportHash,itemIds:['asin:B000000001:summary','asin:B000000002:summary']};
  const first=make();await first.start(f.actor,f.moduleRunId,f.attemptId,request);await first.drain();assert.equal(calls,1);
  summary='The lamp is dimmable.';
  const second=make();await second.start(f.actor,f.moduleRunId,f.attemptId,request);await second.drain();assert.equal(calls,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('v2 successful report translation is retained and promoted for another report without model cost',async()=>{
 const f=await fixture(),root=mkdtempSync(join(process.env.TEMP??'.','theme-legacy-cache-'));
 try{
  let calls=0;const modelIdentity='legacy-model';
  const service=new MarketThemeTranslationService({root,modelIdentity,resolveReport:{resolveReport:async()=>({entry:f.entry,snapshot:f.snapshot,priorEvaluations:[]})} as never,translate:async source=>{calls++;return source.item.original;}});
  const q={reportHash:f.entry.report.reportHash},before=await service.read(f.actor,f.moduleRunId,f.attemptId,q);assert.ok(before);
  const content=before.items.find(i=>i.field==='member-content')!;
  const legacyHash=createHash('sha256').update(JSON.stringify(['market-theme-translation/v2','en-US',modelIdentity,f.actor.organizationId,f.moduleRunId,f.attemptId,q.reportHash,content.itemId,content.original])).digest('hex');
  writeFileSync(join(root,legacyHash+'.json'),JSON.stringify({savedAt:Date.now(),item:{...content,sourceHash:legacyHash,translationVersion:'market-theme-translation/v2',state:'ready',translated:'Not bright for 2 hours'}}));
  await service.start(f.actor,f.moduleRunId,f.attemptId,{...q,itemIds:[content.itemId]});await service.drain();assert.equal(calls,0);
  f.entry.report.reportHash='e'.repeat(64);
  const later=await service.read(f.actor,f.moduleRunId,f.attemptId,{reportHash:f.entry.report.reportHash});assert.ok(later);assert.equal(later.items.find(i=>i.field==='member-content')!.translated,'Not bright for 2 hours');assert.equal(calls,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('glossary matches whole topic labels only, including registered localized names',()=>{
 const source={organizationId:'org',moduleRunId:'run',attemptId:'attempt',reportHash:'a'.repeat(64),language:'de-DE' as const,item:{itemId:'topic',field:'member-keyword' as const,original:' Brightness '}};
 assert.equal(fixedThemeTranslation(source),'Helligkeit');
 assert.equal(fixedThemeTranslation({...source,item:{...source.item,original:'亮度'}}),'Helligkeit');
 assert.equal(fixedThemeTranslation({...source,item:{...source.item,original:'Luminosité'}}),'Helligkeit');
 assert.equal(fixedThemeTranslation({...source,item:{...source.item,original:'Brightness is not sufficient'}}),null);
 assert.equal(fixedThemeTranslation({...source,item:{...source.item,field:'member-content'}}),null);
 assert.equal(fixedThemeTranslation({...source,item:{...source.item,original:'Unregistered term'}}),null);
});

test('content failures are not cached as successes; duplicates share failure and corrupted disk content can be regenerated',async()=>{
 const f=await fixture(),root=mkdtempSync(join(process.env.TEMP??'.','theme-cache-retry-'));
 try {
  let calls=0,fail=true;
  const make=()=>new MarketThemeTranslationService({root,modelIdentity:'cache-failures',resolveReport:{resolveReport:async()=>({entry:f.entry,snapshot:f.snapshot,priorEvaluations:[]})} as never,readSelection:async()=>({samples:[{asin:'B000000001',customerSay:{value:'Not dimmable'}},{asin:'B000000002',customerSay:{value:'Not dimmable'}}]}),translate:async()=>{calls++;if(fail)throw Error('provider timeout');return 'Not dimmable';}});
  const request={reportHash:f.entry.report.reportHash,itemIds:['asin:B000000001:summary','asin:B000000002:summary']};
  const first=make();await first.start(f.actor,f.moduleRunId,f.attemptId,request);await first.drain();assert.equal(calls,1);
  const read=await first.read(f.actor,f.moduleRunId,f.attemptId,{reportHash:request.reportHash});assert.ok(read);
  assert.ok(read.items.filter(i=>i.field==='asin-summary').every(i=>i.state==='failed'&&i.translated===null&&i.original==='Not dimmable'));assert.equal(calls,1);
  fail=false;const retry=make();await retry.start(f.actor,f.moduleRunId,f.attemptId,request);await retry.drain();assert.equal(calls,2);
  for(const filename of readdirSync(join(root,'content')))writeFileSync(join(root,'content',filename),'{corrupt');
  f.entry.report.reportHash='f'.repeat(64);const changed={...request,reportHash:f.entry.report.reportHash},fresh=make();
  const missing=await fresh.read(f.actor,f.moduleRunId,f.attemptId,{reportHash:changed.reportHash});assert.ok(missing);assert.ok(missing.items.filter(i=>i.field==='asin-summary').every(i=>i.state==='missing'));assert.equal(calls,2);
  await fresh.start(f.actor,f.moduleRunId,f.attemptId,changed);await fresh.drain();assert.equal(calls,3);
  const repaired=await make().read(f.actor,f.moduleRunId,f.attemptId,{reportHash:changed.reportHash});assert.ok(repaired);assert.ok(repaired.items.filter(i=>i.field==='asin-summary').every(i=>i.state==='ready'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
