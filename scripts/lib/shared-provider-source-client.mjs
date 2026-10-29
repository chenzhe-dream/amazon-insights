import {sourceCacheFromEnv,SavedSourceMissingError} from './sorftime-source-cache.mjs';
import {assertSourceResponse,cacheTtl,isQuotaResponse,SorftimeQuotaError} from './sorftime-source-policy.mjs';
import {providerEndpoint} from './provider-network.mjs';
import {McpTransportError,normalizeMcpResult} from '../../server/connectors/mcp-transport.mjs';

export function normalizeSharedProviderResult(result,provider) {
  if(isQuotaResponse(result))throw new SorftimeQuotaError(provider);
  if(result?.isError===true)throw new McpTransportError('rpc',null,{boundary:'tool-content'});
  if(result && Object.hasOwn(result,'structuredContent')) {
    if(!result.structuredContent || typeof result.structuredContent!=='object' || Array.isArray(result.structuredContent))throw new McpTransportError('malformed',null,{boundary:'tool-content'});
    return result.structuredContent;
  }
  if(result && Object.hasOwn(result,'content') &&
    (!Array.isArray(result.content)||result.content[0]?.type!=='text'||typeof result.content[0]?.text!=='string')) {
    throw new McpTransportError('malformed',null,{boundary:'tool-content'});
  }
  return normalizeMcpResult(result);
}

/** Common boundary for server connectors and CLI consumers; never cache a mutation. */
export async function withSharedProviderSource(provider,key,tool,args,options,execute) {
  const env=options.env??process.env;
  const cache=options.sourceCache??sourceCacheFromEnv(env,provider);
  const savedOnly=options.savedOnly===true||env.MARKET_EXTERNAL_COLLECTION_MODE==='saved-only';
  if(!cache || cacheTtl(tool,{},provider)===0){if(savedOnly)throw new SavedSourceMissingError();return execute(async()=>{});}
  return cache.run({provider,key,endpoint:providerEndpoint(provider,env),tool,args,savedOnly,
    signal:options.signal,jobId:options.jobId??env.AGENT_SYNC_JOB_ID,
    forceRefresh:options.forceRefresh===true||env.FORCE_REFRESH==='1'||process.argv.includes('--force'),
  },async({recordAttempt})=>{
    const value=await execute(recordAttempt);
    assertSourceResponse(value,provider);
    // Do not persist an accidental credential echo from a supplier response.
    if(JSON.stringify(value).includes(key))throw new Error('Source response contains credential material');
    return value;
  });
}
