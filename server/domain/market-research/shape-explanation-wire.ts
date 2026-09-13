import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { MARKET_SHAPE_EXPLANATION_DIMENSIONS, type MarketShapeExplanationCatalog, type MarketShapeExplanationDimension, type MarketShapeExplanationLimitation, type MarketShapeExplanationRow } from '../../../shared/market-shape-explanation-contracts';
import { MarketShapeExplanationWindowSchema, type MarketShapeExplanationWindow, type MarketShapeExplanationWireLimitation, type MarketShapeExplanationWireRow } from '../../../shared/market-shape-explanation-wire-contracts';
import { validateMarketShapeExplanationCatalog } from './shape-explanation-catalog';

type Fits=(candidate:MarketShapeExplanationWindow)=>boolean|Promise<boolean>;
type Unit={dimension:MarketShapeExplanationDimension;row?:MarketShapeExplanationRow;limitation?:{value:MarketShapeExplanationLimitation;part:number;parts:number;encoding:'text'|'json-array';detail:string}};
const frozen=<T>(value:T):T=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value)}return value};
const abort=(signal?:AbortSignal)=>{if(signal?.aborted){const error=new Error('Market shape explanation window construction aborted');error.name='AbortError';throw error}};

function encode(catalog:MarketShapeExplanationCatalog,dimension:MarketShapeExplanationDimension,units:Unit[],ordinal:number,count:number):MarketShapeExplanationWindow{
  const strings:string[]=[]; const indexes=new Map<string,number>();
  const put=(value:string)=>{let i=indexes.get(value);if(i===undefined){i=strings.length;strings.push(value);indexes.set(value,i)}return i};
  const sourceRows=units.flatMap(x=>x.row?[x.row]:[]);
  const rows:MarketShapeExplanationWireRow[]=sourceRows.map(row=>[
    put(row.id),Object.entries(row.context).map(([k,v])=>[put(k),v===null?null:put(v)]),
    row.cells.map(cell=>[put(cell.id),cell.value,put(cell.unit)]),
  ]);
  const limitations:MarketShapeExplanationWireLimitation[]=units.flatMap(unit=>unit.limitation?[ [put(unit.limitation.value.code),unit.limitation.part,unit.limitation.parts,unit.limitation.encoding,unit.limitation.detail] ]:[]);
  const all=catalog.rows.filter(row=>row.dimension===dimension);
  const body={version:'market-shape-explanation-window/v1' as const,explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,mode:'dimension' as const,dimension,scope:{marketplace:catalog.scope.marketplace,nodeIdPath:catalog.scope.nodeIdPath,fromMonth:catalog.scope.fromMonth,toMonth:catalog.scope.toMonth,currency:catalog.scope.currency},source:{catalogVersion:catalog.source.catalogVersion,dataCutoffAt:catalog.source.dataCutoffAt,comparisonBasis:catalog.source.comparisonBasis,priceBasis:catalog.source.priceBasis,historicalPriceStatus:catalog.source.historicalPriceStatus,structureRuleVersion:catalog.source.structureRuleVersion},rules:{version:'market-shape-explanation-model-rules/v1' as const,limitations:catalog.limitations.filter(item=>{try{return !Array.isArray(JSON.parse(item.detail))}catch{return true}})},fragment:{ordinal,count},coverage:{dimensionRowCount:all.length,dimensionCellCount:all.reduce((n,r)=>n+r.cells.length,0),rowIds:sourceRows.map(r=>r.id)},dictionary:{strings},rows,limitations};
  return {...body,windowId:'market-shape-explanation-window:'+digest(body)};
}

/** Packs complete evidence through the caller's real request meter. Rows are atomic. */
export async function buildMarketShapeExplanationWindows(catalogInput:MarketShapeExplanationCatalog,fits:Fits,signal?:AbortSignal):Promise<readonly MarketShapeExplanationWindow[]>{
  const catalog=validateMarketShapeExplanationCatalog(catalogInput); abort(signal);
  const units:Unit[]=[];
  for(const dimension of MARKET_SHAPE_EXPLANATION_DIMENSIONS){
    const dimensionRows=catalog.rows.filter(r=>r.dimension===dimension);
    units.push(...dimensionRows.map(row=>({dimension,row})));
    if(dimension==='scope') for(const limitation of catalog.limitations){
      let values:string[]=[limitation.detail],encoding:'text'|'json-array'='text';
      try{const parsed=JSON.parse(limitation.detail);if(Array.isArray(parsed)){if(limitation.detail!==JSON.stringify(parsed))throw new TypeError(`Explanation limitation ${limitation.code} must use canonical JSON`);values=parsed.length?parsed.map(value=>JSON.stringify([value])):['[]'];encoding='json-array'}}catch(error){if(error instanceof TypeError)throw error}
      if(encoding==='text')continue;
      for(let part=1;part<=values.length;part++) units.push({dimension,limitation:{value:limitation,part,parts:values.length,encoding,detail:values[part-1]!}});
    }
    if(!units.some(unit=>unit.dimension===dimension))units.push({dimension});
  }
  const groups:Unit[][]=[];
  for(let cursor=0;cursor<units.length;){
    abort(signal); const dimension=units[cursor]!.dimension; let best=0;
    for(let take=1;cursor+take<=units.length&&units[cursor+take-1]!.dimension===dimension;take++){
      const candidate=encode(catalog,dimension,units.slice(cursor,cursor+take),999999999,999999999);
      if(await fits(candidate)) best=take; else break;
    }
    if(!best) throw new RangeError(`Market shape explanation atomic row or metadata cannot fit request budget (${dimension})`);
    groups.push(units.slice(cursor,cursor+best)); cursor+=best;
  }
  // Final ordinals/counts affect the native meter, so re-pack until every final object fits.
  for(;;){
    const windows=groups.map((group,i)=>{const peers=groups.filter(g=>g[0]!.dimension===group[0]!.dimension);return encode(catalog,group[0]!.dimension,group,peers.indexOf(group)+1,peers.length)});
    let changed=false;
    for(let i=0;i<windows.length;i++){abort(signal);if(await fits(windows[i]!))continue;
      const group=groups[i]!; if(group.length===1)throw new RangeError(`Market shape explanation atomic row or metadata cannot fit request budget (${group[0]!.dimension})`);
      const split=Math.floor(group.length/2);groups.splice(i,1,group.slice(0,split),group.slice(split));changed=true;break;
    }
    if(!changed)return frozen(windows);
  }
}

function decodeRaw(window:MarketShapeExplanationWindow){
  const get=(i:number)=>{const value=window.dictionary.strings[i];if(value===undefined)throw new TypeError('Unknown compact explanation reference');return value};
  const rows=window.rows.map(r=>({id:get(r[0]),dimension:window.dimension,context:Object.fromEntries(r[1].map(([k,v])=>[get(k),v===null?null:get(v)])),cells:r[2].map(c=>({id:get(c[0]),value:c[1],unit:get(c[2])}))}));
  const limitations=window.limitations.map(l=>({code:get(l[0]),part:l[1],parts:l[2],encoding:l[3],detail:l[4]}));
  return {rows,limitations};
}
export function validateMarketShapeExplanationWindow(catalogInput:MarketShapeExplanationCatalog,input:unknown):MarketShapeExplanationWindow{
  const catalog=validateMarketShapeExplanationCatalog(catalogInput),window=MarketShapeExplanationWindowSchema.parse(input);
  const {windowId,...body}=window;if(windowId!=='market-shape-explanation-window:'+digest(body))throw new TypeError('Shape explanation window digest differs');
  if(window.explanationCatalogId!==catalog.explanationCatalogId||window.revisionId!==catalog.revisionId)throw new TypeError('Shape explanation window belongs to another catalog revision');
  const expectedScope={marketplace:catalog.scope.marketplace,nodeIdPath:catalog.scope.nodeIdPath,fromMonth:catalog.scope.fromMonth,toMonth:catalog.scope.toMonth,currency:catalog.scope.currency},expectedSource={catalogVersion:catalog.source.catalogVersion,dataCutoffAt:catalog.source.dataCutoffAt,comparisonBasis:catalog.source.comparisonBasis,priceBasis:catalog.source.priceBasis,historicalPriceStatus:catalog.source.historicalPriceStatus,structureRuleVersion:catalog.source.structureRuleVersion};
  if(digest(window.scope)!==digest(expectedScope)||digest(window.source)!==digest(expectedSource))throw new TypeError('Shape explanation window source metadata differs');
  const expectedRules=catalog.limitations.filter(item=>{try{return !Array.isArray(JSON.parse(item.detail))}catch{return true}});if(digest(window.rules.limitations)!==digest(expectedRules))throw new TypeError('Shape explanation window model rules differ');
  const decoded=decodeRaw(window),expected=new Map(catalog.rows.map(r=>[r.id,r]));
  if(decoded.limitations.some(item=>item.encoding==='text'))throw new TypeError('Text limitation encoding duplicates the fixed model rules');
  const dimensionRows=catalog.rows.filter(r=>r.dimension===window.dimension);
  if(window.coverage.dimensionRowCount!==dimensionRows.length||window.coverage.dimensionCellCount!==dimensionRows.reduce((n,r)=>n+r.cells.length,0))throw new TypeError('Shape explanation dimension coverage differs');
  if(new Set(window.coverage.rowIds).size!==window.coverage.rowIds.length)throw new TypeError('Duplicate window row reference');
  if(JSON.stringify(window.coverage.rowIds)!==JSON.stringify(decoded.rows.map(r=>r.id)))throw new TypeError('Window coverage differs from compact rows');
  for(const row of decoded.rows){const original=expected.get(row.id),materialized=original?{id:row.id,dimension:row.dimension,path:original.path,context:row.context,cells:row.cells.map((c,i)=>({id:c.id,path:original.cells[i]?.path,value:c.value,unit:c.unit}))}:null;if(!original||original.dimension!==window.dimension||digest(materialized)!==digest(original))throw new TypeError('Unknown or altered compact explanation row');}
  for(const item of decoded.limitations){const original=catalog.limitations.find(x=>x.code===item.code);let values:string[]=[],encoding:'text'|'json-array'='text';if(original){try{const parsed=JSON.parse(original.detail);if(Array.isArray(parsed)){values=parsed.length?parsed.map(value=>JSON.stringify([value])):['[]'];encoding='json-array'}else values=[original.detail]}catch{values=[original.detail]}}if(!original||item.parts!==values.length||item.parts<item.part||item.encoding!==encoding||item.detail!==values[item.part-1])throw new TypeError('Unknown or altered compact explanation limitation');}
  const canonicalUnits:Unit[]=[...window.coverage.rowIds.map(id=>({dimension:window.dimension,row:expected.get(id)!})),...decoded.limitations.map(item=>({dimension:window.dimension,limitation:{value:catalog.limitations.find(value=>value.code===item.code)!,part:item.part,parts:item.parts,encoding:item.encoding,detail:item.detail}}))];
  if(!canonicalUnits.length)canonicalUnits.push({dimension:window.dimension});
  const canonical=encode(catalog,window.dimension,canonicalUnits,window.fragment.ordinal,window.fragment.count);
  if(digest(canonical)!==digest(window))throw new TypeError('Non-canonical explanation window encoding or limitation fragment');
  return frozen(window);
}
/** Decodes exactly what one model request can cite. Original paths are restored server-side. */
export function decodeMarketShapeExplanationWindow(catalogInput:MarketShapeExplanationCatalog,input:unknown):{rows:MarketShapeExplanationRow[];limitations:MarketShapeExplanationLimitation[]}{
  const catalog=validateMarketShapeExplanationCatalog(catalogInput),window=validateMarketShapeExplanationWindow(catalog,input),raw=decodeRaw(window),byId=new Map(catalog.rows.map(row=>[row.id,row]));
  const rows=raw.rows.map(row=>{const original=byId.get(row.id)!;return {...row,path:original.path,cells:row.cells.map((cell,i)=>({id:cell.id,path:original.cells[i]!.path,value:cell.value,unit:cell.unit}))}});
  return {rows,limitations:[...window.rules.limitations,...raw.limitations.map(item=>({code:item.code,detail:item.detail}))]};
}
export function decodeMarketShapeExplanationWindows(catalogInput:MarketShapeExplanationCatalog,inputs:readonly unknown[]):{rows:MarketShapeExplanationRow[];limitations:MarketShapeExplanationLimitation[]}{
  const catalog=validateMarketShapeExplanationCatalog(catalogInput),windows=inputs.map(x=>validateMarketShapeExplanationWindow(catalog,x));
  if(!windows.length)throw new TypeError('Explanation window manifest is empty');
  if(new Set(windows.map(window=>window.windowId)).size!==windows.length)throw new TypeError('Duplicate explanation window in manifest');
  for(const dimension of MARKET_SHAPE_EXPLANATION_DIMENSIONS){const fragments=windows.filter(window=>window.dimension===dimension);if(!fragments.length)throw new TypeError(`Explanation window manifest is missing ${dimension}`);const count=fragments[0]!.fragment.count,ordinals=fragments.map(window=>window.fragment.ordinal).sort((a,b)=>a-b);if(fragments.some(window=>window.fragment.count!==count)||count!==fragments.length||ordinals.some((ordinal,index)=>ordinal!==index+1))throw new TypeError(`Inconsistent explanation fragment manifest for ${dimension}`)}
  const compactRows=windows.flatMap(w=>decodeRaw(w).rows),catalogRows=new Map(catalog.rows.map(r=>[r.id,r])),rows=compactRows.map(row=>{const original=catalogRows.get(row.id)!;return {...row,path:original.path,cells:row.cells.map((cell,i)=>({...cell,path:original.cells[i]!.path}))}}),pieces=new Map<string,{parts:number;encoding:'text'|'json-array';values:Map<number,string>}>();
  for(const w of windows)for(const l of decodeRaw(w).limitations){let p=pieces.get(l.code);if(!p){p={parts:l.parts,encoding:l.encoding,values:new Map};pieces.set(l.code,p)}if(p.parts!==l.parts||p.encoding!==l.encoding||p.values.has(l.part))throw new TypeError('Duplicate or inconsistent limitation fragment');p.values.set(l.part,l.detail)}
  const ruleCodes=new Set(windows.flatMap(window=>window.rules.limitations.map(item=>item.code)));
  const limitations=catalog.limitations.map(item=>{const p=pieces.get(item.code);if(!p){if(ruleCodes.has(item.code))return item;throw new TypeError('Missing explanation limitation fragment')}if(p.values.size!==p.parts)throw new TypeError('Missing explanation limitation fragment');const ordered=Array.from({length:p.parts},(_,i)=>p!.values.get(i+1)??'');const detail=p.encoding==='json-array'?JSON.stringify(ordered.flatMap(value=>JSON.parse(value))):ordered.join('');if(detail!==item.detail)throw new TypeError('Altered explanation limitation');return item});
  const byId=new Map(rows.map(row=>[row.id,row]));
  if(rows.length!==catalog.rows.length||byId.size!==rows.length||catalog.rows.some(row=>digest(byId.get(row.id))!==digest(row)))throw new TypeError('Explanation windows do not cover catalog rows exactly');
  return {rows:[...catalog.rows],limitations:[...limitations]};
}
