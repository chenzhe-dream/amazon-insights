import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {marketOverviewSynthesisReportDefinition} from '../../server/domain/market-research/overview-synthesis-continuation';
import {readMarketOverviewSynthesisReport} from '../../server/runtime/market-overview-synthesis-report-reader';
import type {PostgresQueryContext} from '../../server/db/postgres/query-context';
import type {MarketModuleRunView} from '../../server/db/market-module-execution-repository';

test('overview final reader rejects altered report binding and missing frozen attempts before reading storage',async()=>{
 const input={phase:'overview-synthesis-report' as const,sourceReportAttemptId:randomUUID(),roundAttemptId:randomUUID(),modelAttemptId:randomUUID(),inputSnapshotId:'market-input:'+'a'.repeat(64)};
 const definition=marketOverviewSynthesisReportDefinition(input),context={} as PostgresQueryContext,view={run:{moduleKind:'overview'},steps:[],attempts:[]} as unknown as MarketModuleRunView;
 await assert.rejects(readMarketOverviewSynthesisReport(context,view,{...definition,input:{...input,modelAttemptId:randomUUID()}},new AbortController().signal),/frozen evidence is unavailable/);
 await assert.rejects(readMarketOverviewSynthesisReport(context,view,definition,new AbortController().signal),/frozen evidence is unavailable/);
 const aborted=new AbortController();aborted.abort();await assert.rejects(readMarketOverviewSynthesisReport(context,view,definition,aborted.signal),error=>(error as Error).name==='AbortError');
});
