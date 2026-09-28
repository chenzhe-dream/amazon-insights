export const MARKET_OVERVIEW_CACHE_TTL_MS=7*24*60*60*1000;

/** Active work is resumed; saved results expire without deleting explicit history. */
export function canReuseOverviewRun(run:{status:string;createdAt:string},now=Date.now()){
  return run.status==='queued'||run.status==='running'||Date.parse(run.createdAt)>=now-MARKET_OVERVIEW_CACHE_TTL_MS;
}
