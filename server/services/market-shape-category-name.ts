import {MarketSiteSchema,sorftimeMarketSite} from '../../shared/market-sites';
import type {RemoteMcpConnector} from '../connectors/connector-contract';
import {executeOnce} from './market-keyword-collector';

export class ShapeCategoryNameError extends Error {
 constructor(readonly reason:'empty'|'ambiguous'|'invalid-response') {super(reason);}
}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

export async function resolveShapeCategoryName(input:{marketplace:string;name:string;organizationId:string;jobId:string;connector:RemoteMcpConnector;signal?:AbortSignal}):Promise<string>{
 if(input.connector.id!=='sorftime')throw new ShapeCategoryNameError('invalid-response');
 const name=input.name.trim();
 const response=await executeOnce(input.connector,{operation:'category_name_search',input:{category_name:name,amz_site:sorftimeMarketSite(MarketSiteSchema.parse(input.marketplace))},governorScope:{organizationId:input.organizationId,jobId:input.jobId}},60000,input.signal);
 const envelope=object(response.data);
 if(envelope.success===false||envelope.error||envelope.code!==undefined&&!['OK',200,'200',0,'0'].includes(envelope.code as string|number))throw new ShapeCategoryNameError('invalid-response');
 const rows=envelope.data;
 if(!Array.isArray(rows)||rows.length>500)throw new ShapeCategoryNameError('invalid-response');
 const exact=rows.map(object).filter(row=>typeof row.category_name==='string'&&row.category_name.trim().toLocaleLowerCase('en-US')===name.toLocaleLowerCase('en-US'));
 const ids=new Set(exact.map(row=>String(row.node_id??'')).filter(id=>/^\d+$/.test(id)));
 if(exact.length===0)throw new ShapeCategoryNameError('empty');
 if(ids.size!==1||exact.some(row=>!/^\d+$/.test(String(row.node_id??''))))throw new ShapeCategoryNameError('ambiguous');
 return [...ids][0];
}
