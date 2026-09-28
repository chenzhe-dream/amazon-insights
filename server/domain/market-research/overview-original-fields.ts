import type {MarketAnalysisScope} from '../../../shared/market-analysis-contracts';
import type {MarketSourceEvidence} from '../../../shared/market-source-contracts';
import {MarketOverviewOriginalFieldsSchema} from '../../../shared/market-overview-original-fields';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';

type Parameters={headTopN:5|10|20;newProductMonths:1|3|6|12};
type Unit='count'|'currency'|'percent'|'lb'|'g'|'in3'|'cm3'|'date';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const numeric=(v:unknown,allowNegative=false)=>{
  const number=typeof v==='number'?v:typeof v==='string'&&new RegExp(`^${allowNegative?'-?':''}(?:0|[1-9]\\d*)(?:\\.\\d+)?$`).test(v.trim())?Number(v.trim()):null;
  return number!==null&&Number.isFinite(number)&&(allowNegative||number>=0)?number:null;
};
const calendarDate=(raw:unknown)=>{
  const date=typeof raw==='string'?raw.slice(0,10):'';
  if(!/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date))return null;
  const parsed=new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===date?date:null;
};
const definition=(head:string,neu:string):Record<string,{unit:Unit;primary:string;secondary?:string;percentConvert?:boolean;divideHead?:boolean}>=>({
  avgBsr:{unit:'count',primary:'avgBsr',secondary:'avgBsr'},avgSellers:{unit:'count',primary:'avgSellers',secondary:'avgSellers'},avgProfit:{unit:'percent',primary:'avgProfit',secondary:'avgProfit'},
  avgWeightLb:{unit:'lb',primary:'avgWeight',secondary:'avgWeight'},avgWeightG:{unit:'g',primary:'baseAvgWeight',secondary:'baseAvgWeight'},avgVolumeIn3:{unit:'in3',primary:'avgVolume',secondary:'avgVolume'},avgVolumeCm3:{unit:'cm3',primary:'baseAvgVolume',secondary:'baseAvgVolume'},
  avgRevenue:{unit:'currency',primary:'avgRevenue',secondary:'avgRevenue'},
  hlAvgUnits:{unit:'count',primary:`${head}ProductSales`,secondary:'hlAvgUnits',divideHead:true},hlAvgRevenue:{unit:'currency',primary:`${head}ProductRevenue`,secondary:'hlAvgRevenue',divideHead:true},
  hlAvgBsr:{unit:'count',primary:'',secondary:'hlAvgBsr'},hlAvgPrice:{unit:'currency',primary:'',secondary:'hlAvgPrice'},hlAvgRating:{unit:'count',primary:'',secondary:'hlAvgRating'},
  productCrn:{unit:'percent',primary:`${head}ProductCrn`,percentConvert:true},brandCrn:{unit:'percent',primary:`${head}BrandCrn`,percentConvert:true},sellerCrn:{unit:'percent',primary:`${head}SellerCrn`,percentConvert:true},
  newCount:{unit:'count',primary:`${neu}NewCount`,secondary:'newProducts'},newRatio:{unit:'percent',primary:`${neu}NewRatio`,secondary:'newProductProportion',percentConvert:true},
  newAvgPrice:{unit:'currency',primary:`${neu}NewAvgPrice`,secondary:'newAvgPrice'},newAvgRatings:{unit:'count',primary:`${neu}NewAvgReviews`,secondary:'newAvgRatings'},newAvgRating:{unit:'count',primary:`${neu}NewAvgRating`,secondary:'newAvgRating'},
  newAvgUnits:{unit:'count',primary:`${neu}NewAvgSales`,secondary:'newAvgUnits'},newAvgRevenue:{unit:'currency',primary:`${neu}NewAvgRevenue`,secondary:'newAvgRevenue'},
  firstShelfDate:{unit:'date',primary:'firstShelfDate',secondary:'firstShelfDate'},lastShelfDate:{unit:'date',primary:'lastShelfDate',secondary:'lastShelfDate'},
});

/** Reads only the exact saved monthly aggregate endpoints; the caller has already replayed their receipts. */
export function projectMarketOverviewOriginalFields(input:{scope:MarketAnalysisScope;parameters:Parameters;sources:readonly MarketSourceEvidence[]}){
  const {scope,parameters}=input,month=scope.toMonth;
  const source=(operation:string)=>input.sources.find(s=>s.provider==='sellerSprite'&&s.operation===operation&&s.scope.organizationId===scope.organizationId&&s.scope.researchId===scope.researchId&&s.scope.marketplace===scope.marketplace&&s.scope.nodeIdPath===scope.nodeIdPath&&s.scope.currency===scope.currency&&s.requestIdentity.marketplace===scope.marketplace&&s.requestIdentity.nodeIdPath===scope.nodeIdPath&&s.requestIdentity.month===month&&s.observationPeriod.kind==='calendar-months'&&s.observationPeriod.fromMonth===month&&s.observationPeriod.toMonth===month);
  const research=source('market_research'),statistics=source('market_research_statistics');
  const row=(s:MarketSourceEvidence|undefined)=>{const data=obj(obj(s?.payload).data??s?.payload);if(s?.operation==='market_research'){
    const nodeId=scope.nodeIdPath.split(':').at(-1);
    const matches=Array.isArray(data.items)?data.items.map(obj).filter(item=>item.nodeIdPath===scope.nodeIdPath||item.nodeIdPath===undefined&&String(item.nodeId??'')===nodeId):[];return matches.length===1?matches[0]:{};
  }return data.nodeIdPath===undefined||data.nodeIdPath===scope.nodeIdPath?data:{};};
  const main=row(research),stats=row(statistics),head=`top${parameters.headTopN}`,neu=`l${parameters.newProductMonths}`;
  const fields:Record<string,unknown>={};
  for(const [name,d] of Object.entries(definition(head,neu))){
    const candidates:[[MarketSourceEvidence|undefined,Record<string,unknown>,string],[MarketSourceEvidence|undefined,Record<string,unknown>,string]]=[[research,main,d.primary],[statistics,stats,d.secondary??'']];
    const present=candidates.filter(([s,r,key])=>s&&key&&r[key]!==undefined&&r[key]!==null);
    const chosen=present.find(([,r,key])=>d.unit==='date'?calendarDate(r[key])!==null:numeric(r[key],name==='avgProfit')!==null)??present[0];
    let value:number|string|null=null,reason:'not-collected'|'field-absent'|'invalid-source'|'unit-unknown'|null=chosen?null:research||statistics?'field-absent':'not-collected';
    if(chosen){const [s,r,key]=chosen,raw=r[key],unit=s!.units[key];
      if(d.unit==='date'){
        const date=calendarDate(raw);if(date)value=date;else reason='invalid-source';
      }else{
        const n=numeric(raw,name==='avgProfit');if(n===null)reason='invalid-source';
        else if(d.unit==='currency'&&(!s!.responseIdentity.currency.echoes.some(e=>e.value===scope.currency)||r.currency!==undefined&&r.currency!==scope.currency||unit?.status==='known'&&(unit.unit!=='currency'||unit.currency!==scope.currency)))reason='unit-unknown';
        else if(unit?.status==='known'&&((d.unit==='count'&&unit.unit!=='count')||(d.unit==='percent'&&!['ratio','percent','count'].includes(unit.unit))))reason='unit-unknown';
        else value=d.divideHead&&s===research?n/parameters.headTopN:d.percentConvert&&s===research&&n>=0&&n<=1?n*100:n;
      }
    }
    const s=chosen?.[0],key=chosen?.[2];
    fields[name]={value,unit:d.unit,sourceRef:s?`market-source:${digest(s)}`:null,sourceField:key||null,scopeBasis:s?s.responseIdentity.nodeIdPath.status==='verified'&&s.responseIdentity.month.status==='verified'?'response-verified':'request-bound':null,reason};
  }
  return MarketOverviewOriginalFieldsSchema.parse({month,headTopN:parameters.headTopN,newProductMonths:parameters.newProductMonths,currency:scope.currency,fields});
}
