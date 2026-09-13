import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PostgresQueryContext } from '../../../server/db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../../../server/db/postgres/market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from '../../../server/db/postgres/market-module-execution-store';
import { PostgresMarketShapePriceRevisionStore } from '../../../server/db/postgres/market-shape-price-revision-store';
import { createMarketSourceStepHandlers } from '../../../server/runtime/market-source-step-handlers';
import { MarketModuleStepWorker } from '../../../server/runtime/market-module-step-worker';
import type { RemoteMcpConnector } from '../../../server/connectors/connector-contract';

export async function createMarketShapeExplanationRunFixture(pool: Pool, options: {productCount?:number;uniqueBrands?:boolean;catalogVersion?:'market-shape-price-catalog/v1'|'market-shape-price-catalog/v3'} = {}) {
  const context = new PostgresQueryContext(pool);
  const snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  const steps = new PostgresMarketModuleExecutionStore(context);
  const revisions = new PostgresMarketShapePriceRevisionStore(context);
  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  await pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Shape explanation fixture','member','active',now(),now())", [actor.userId, actor.organizationId, `${actor.userId}@example.com`]);
  const scope = { organizationId: actor.organizationId, researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '1:2:3', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  await snapshots.createStudy({ actor, scope, idempotencyKey: randomUUID(), now: new Date().toISOString() });
  const asins = Array.from({length:options.productCount??2},(_,index)=>`B${String(index+1).padStart(9,'0')}`);
  const connector: RemoteMcpConnector = { id: 'sellerSprite', probe: async () => { throw Error('unused'); }, execute: async request => {
    const month = (request.input as any).request.month;
    return { data: { code: 'OK', marketplace: 'US', nodeIdPath: scope.nodeIdPath, month, currency: 'USD', data: asins.map((asin, index) => ({ asin, title: `Fixture ${index}`, brand: options.uniqueBrands?`Fixture brand ${index}`:'Fixture', price: 10 + index, totalUnits: 20 + index, totalRevenue: 0, ranking: index + 1, rating: 4, ratings: 20, sellerName: 'Fixture', sellerType: 'FBA', shelfDate: '2025-01-10' })) }, source: { connectorId: 'sellerSprite', operation: request.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } };
  const handlers = createMarketSourceStepHandlers({ context, connectors: { sellerSprite: connector, sorftime: { ...connector, id: 'sorftime' } } });
  const worker = new MarketModuleStepWorker({ steps, handlers: { ...handlers, 'collect-product-month': async input => {
    const work = await handlers['collect-product-month'](input);
    if ((input.claim.step.input as any).month === '2026-08' && work.kind === 'settlement' && work.value.outcome.status === 'succeeded') {
      const basis = (work.value.outcome.output as any).inputSnapshotId;
      work.value.children = [{ stepKey: 'history/2026-07', kind: 'collect-product-month', subject: {}, input: { month: '2026-07', poolSize: asins.length, newProductMonths: 6, selectedAsins: asins, selectionInputSnapshotId: basis }, inputRefs: [{ kind: 'input', id: basis }] }];
    }
    return work;
  } } });
  const parent = await steps.createModuleRun({ actor, scope, moduleKind: 'shape-price', params: {}, versions: { source: 'market-source-handlers/v1', rule: options.catalogVersion??'market-shape-price-catalog/v1', mapping: 'synthetic/v1', planner: 'synthetic/v1', model: null, prompt: null, configuration: null }, collectionRevision: 'initial/v1', idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'reference', kind: 'collect-product-month', subject: {}, input: { month: '2026-08', poolSize: 100, newProductMonths: 6 }, inputRefs: [] }] });
  await worker.tick(); await worker.tick(); await worker.stop();
  const view = (await steps.findModuleRun({ actor, moduleRunId: parent.run.id }))!;
  const reference = view.attempts.find(a => view.steps.find(s => s.id === a.stepId)?.stepKey === 'reference')!;
  const history = view.attempts.find(a => a.id !== reference.id)!;
  const request = { referenceAttemptId: reference.id, historyAttemptIds: [history.id], expectedParentRevisionId: null, selectedAsins: asins, taxonomyVersion: 'synthetic/v1', labels: [{ labelId: 'lamp', label: '灯', definition: '人工确认灯型' }], assignments: asins.map(asin => ({ asin, labelId: 'lamp' })), bands: [{ id: 'all', minInclusive: 0, maxExclusive: null }], note: 'fixture' };
  return { context, actor, scope, parentRunId: parent.run.id, request, revisions, steps };
}
