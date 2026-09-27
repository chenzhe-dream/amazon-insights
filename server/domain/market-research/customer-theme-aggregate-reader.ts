import { z } from 'zod';
import { aggregateCustomerThemes, type CustomerThemesAsinInput, type CustomerThemesAsinSummary } from './customer-themes';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new TypeError('Theme aggregate differs from its complete source evidence');};

/** Rebuild numeric evidence before pagination. Saved model decisions supply only
 * group membership; counts and denominator coverage come from every source ASIN. */
export function restoreMarketThemeAggregate(savedValue:unknown,perAsin:CustomerThemesAsinSummary[],groups:unknown[],mappings:{sourceThemeId:string;groupId:string}[]){
  const saved=obj(savedValue),selection=z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(20).parse(obj(saved.scope).selectedAsins);
  const results:CustomerThemesAsinInput[]=[];
  for(let i=0;i<selection.length;i++){
    const a=perAsin[i];if(!a||a.asin!==selection[i]||!Array.isArray(a.themes))throw new TypeError('Missing ASIN rule evidence');
    if(a.reportedStatus===null)continue;
    if(a.reportedStatus==='success'){
      if(!a.source)throw new TypeError('Missing successful ASIN source');
      results.push({asin:a.asin,status:'success',source:a.source,...(a.quarantine?{quarantine:a.quarantine}:{}),themes:a.themes.map(t=>({sourceThemeId:t.sourceThemeId,keyword:t.keyword,content:t.content,
        mention:t.mention,positive:t.positive,negative:t.negative,sourceUpdatedAt:t.sourceUpdatedAt}))});
    }else{
      if((a.reportedStatus!=='empty'&&a.reportedStatus!=='failed')||!a.reason)throw new TypeError('Invalid ASIN result');
      results.push({asin:a.asin,status:a.reportedStatus,source:a.source,reason:a.reason});
    }
  }
  const topN=z.number().int().nonnegative().safe().nullable().parse(obj(saved.display).topN);
  const aggregation=aggregateCustomerThemes({selectedAsins:selection,results,mappings,...(topN===null?{}:{topN})});
  const {groups:rebuiltGroups,perAsin:rebuiltAsins,mappings:rebuiltMappings,...summary}=aggregation;
  same(saved,summary);same(perAsin,rebuiltAsins);same(groups,rebuiltGroups);same(mappings,rebuiltMappings);
  return aggregation;
}
