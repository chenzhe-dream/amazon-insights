import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {marketShapeExplanationReportDefinition} from '../../server/domain/market-research/shape-explanation-continuation';
import {readMarketShapeExplanationReport} from '../../server/runtime/market-shape-explanation-report-reader';
import type {PostgresQueryContext} from '../../server/db/postgres/query-context';
import type {MarketModuleRunView} from '../../server/db/market-module-execution-repository';

const ids={windowAttemptId:randomUUID(),roundAttemptId:randomUUID(),modelAttemptId:randomUUID(),inputSnapshotId:'market-input:'+'a'.repeat(64)};
const definition=marketShapeExplanationReportDefinition({phase:'shape-explanation-report',...ids});
const view={run:{id:randomUUID(),scope:{organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US',nodeIdPath:'1:2',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD'},moduleKind:'shape-price',params:{flow:'shape-explanation/v1'},versions:{source:'x',rule:'x',mapping:'x',planner:'x',model:'x',prompt:'x',configuration:'x'},collectionRevision:'x',requestFingerprint:'f'.repeat(64),status:'running',createdBy:randomUUID(),createdAt:new Date().toISOString(),planRevision:1,latestReportAttemptId:null},steps:[],attempts:[]} as unknown as MarketModuleRunView;
const unreachable={} as PostgresQueryContext;

test('shape report reader rejects a changed immutable report definition before storage access',async()=>{
 const changed={...definition,input:{phase:'shape-explanation-report' as const,...ids,inputSnapshotId:'market-input:'+'b'.repeat(64)}};
 await assert.rejects(readMarketShapeExplanationReport(unreachable,view,changed,new AbortController().signal),/frozen evidence is unavailable/);
});

test('shape report reader rejects stale frontier and aborts before evidence recovery',async()=>{
 await assert.rejects(readMarketShapeExplanationReport(unreachable,view,definition,new AbortController().signal),/anchor is missing|frozen evidence is unavailable/);
 const aborted=new AbortController();aborted.abort();await assert.rejects(readMarketShapeExplanationReport(unreachable,view,definition,aborted.signal),error=>(error as Error).name==='AbortError');
});
