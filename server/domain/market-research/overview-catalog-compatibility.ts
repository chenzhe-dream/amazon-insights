import type {MarketInputSnapshot} from '../../../shared/market-analysis-contracts';
import {createMarketInputSnapshot} from './snapshot';

export class MarketOverviewEvidenceError extends Error {
  constructor(){super('Overview source receipt or execution binding differs');this.name='MarketOverviewEvidenceError';}
}

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** The Oct 8 product drill-down added productItems without changing the catalog
 * version. Reconstruct only that prior serialization, and accept it only when
 * its full content hash equals the receipt. All other facts remain exact. */
export function restoreOverviewNumericSnapshot(snapshot:MarketInputSnapshot,expectedId:unknown):MarketInputSnapshot{
  if(snapshot.snapshotId===expectedId)return snapshot;
  if(!/^market-overview-source-catalog\/v[4-7]$/.test(snapshot.ruleVersion))throw new MarketOverviewEvidenceError();
  const records=structuredClone(snapshot.records);
  for(const record of records){
    if(!object(record.data)||!Array.isArray(record.data.distributions))continue;
    for(const entry of record.data.distributions){
      if(!object(entry)||!object(entry.distribution)||!Array.isArray(entry.distribution.rows))continue;
      for(const row of entry.distribution.rows)if(object(row))delete row.productItems;
    }
  }
  const legacy=createMarketInputSnapshot({scope:snapshot.scope,kind:snapshot.kind,sourceVersion:snapshot.sourceVersion,ruleVersion:snapshot.ruleVersion,collectedAt:snapshot.collectedAt,expectedRecordIds:snapshot.expectedRecordIds,records});
  if(legacy.snapshotId!==expectedId)throw new MarketOverviewEvidenceError();
  return legacy;
}
