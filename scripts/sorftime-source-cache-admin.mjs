import fs from 'node:fs/promises';
import pg from 'pg';
import {createSorftimeSourceCache} from './lib/sorftime-source-cache.mjs';
import {readServerConnectorSecret} from '../server/config/connector-secrets.mjs';
import {providerEndpoint} from './lib/provider-network.mjs';

// No command in this CLI calls Sorftime. Use the intended runtime's environment.
const [action='summary',file]=process.argv.slice(2);
const provider=process.env.SOURCE_CACHE_PROVIDER??'sorftime';
if(!['sorftime','sellerSprite','sif'].includes(provider))throw new Error('Invalid SOURCE_CACHE_PROVIDER');
if(!['summary','estimate','resume','prune'].includes(action))throw new Error('Use summary | estimate <request-json> | resume | prune');
if(!process.env.AGENT_DATABASE_URL)throw new Error('AGENT_DATABASE_URL is required');
const pool=new pg.Pool({connectionString:process.env.AGENT_DATABASE_URL,max:1});
try {
  const cache=createSorftimeSourceCache({pool});
  if(action==='summary') {
    const events=await pool.query("SELECT operation,kind,count(*)::int AS requests,sum(estimated_units)::int AS estimated_units FROM sorftime_source_events WHERE recorded_at>now()-interval '24 hours' GROUP BY operation,kind ORDER BY operation,kind");
    const cached=await pool.query("SELECT count(*)::int AS fresh_responses FROM sorftime_source_cache WHERE expires_at>now()");
    console.log(JSON.stringify({billingConfirmed:false,windowHours:24,...cached.rows[0],events:events.rows},null,2));
  } else if(action==='prune') {
    // Expired source payloads retained 30 days for parser replay; reports own immutable evidence.
    const payloads=await pool.query("DELETE FROM sorftime_source_cache WHERE expires_at<now()-interval '30 days'");
    const events=await pool.query("DELETE FROM sorftime_source_events WHERE recorded_at<now()-interval '90 days'");
    await pool.query("DELETE FROM sorftime_source_pauses WHERE until_at<now()");
    await pool.query("DELETE FROM sorftime_source_refresh_scopes WHERE not_before<now()-interval '30 days'");
    console.log(JSON.stringify({removedExpiredSources:payloads.rowCount,removedOldEvents:events.rowCount}));
  } else {
    const key=readServerConnectorSecret(provider);
    if(!key)throw new Error('Provider credential required to identify its cache scope');
    const endpoint=providerEndpoint(provider);
    if(action==='resume') {
      await cache.clearQuotaPause({provider,key,endpoint,tool:'',args:{}});
      console.log('Provider credential quota pause cleared. No collection started.');
    } else {
      if(!file)throw new Error('Request JSON file is required');
      const requests=JSON.parse(await fs.readFile(file,'utf8'));
      if(!Array.isArray(requests)||requests.some(r=>typeof r?.tool!=='string'||!r.args||typeof r.args!=='object'||Array.isArray(r.args)))throw new Error('Expected [{tool,args}]');
      console.log(JSON.stringify(await cache.estimate(requests.map(({tool,args})=>({provider,key,endpoint,tool,args}))),null,2));
    }
  }
} finally {await pool.end();}
