import { MarketShapeExplanationFragmentOutputSchema, MarketShapeExplanationFragmentResultSchema } from '../../../shared/market-shape-explanation-fragment-contracts';
import type { MarketShapeExplanationCatalog } from '../../../shared/market-shape-explanation-contracts';
import type { MarketShapeExplanationWindow } from '../../../shared/market-shape-explanation-wire-contracts';
import { validateMarketShapeExplanationCatalog } from './shape-explanation-catalog';
import { validateMarketShapeExplanationSection } from './shape-explanation-validation';
import { validateMarketShapeExplanationWindow, decodeMarketShapeExplanationWindow, decodeMarketShapeExplanationWindows } from './shape-explanation-wire';

function freeze<T>(value:T):T { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
export function validateMarketShapeExplanationFragment(catalogValue:MarketShapeExplanationCatalog, windowValue:MarketShapeExplanationWindow, outputValue:unknown) {
  const catalog=validateMarketShapeExplanationCatalog(catalogValue),window=validateMarketShapeExplanationWindow(catalog,windowValue);
  const output=MarketShapeExplanationFragmentOutputSchema.parse(outputValue);
  if(output.explanationCatalogId!==catalog.explanationCatalogId||output.revisionId!==catalog.revisionId||output.windowId!==window.windowId||output.section.dimension!==window.dimension)
    throw new TypeError('Shape explanation fragment identity differs from its window');
  const section=validateMarketShapeExplanationSection(catalog,output.section,window.coverage.rowIds);
  const required=decodeMarketShapeExplanationWindow(catalog,window).limitations.map(l=>l.code);
  const visible=new Set(required);
  if([section.summary,...section.findings,...section.limitations,...section.verification].some(s=>s.limitationCodes.some(code=>!visible.has(code))))
    throw new TypeError('Explanation cites a limitation outside its model window');
  const cited=new Set(section.limitations.flatMap(item=>item.limitationCodes));
  if(required.some(code=>!cited.has(code)))throw new TypeError('Shape explanation fragment omitted a window limitation');
  return freeze({...output,section});
}

/** A complete set of local interpretations only enables the synthesis phase.
 * This function never combines prose or declares the final A2 report ready. */
export function collectMarketShapeExplanationFragments(catalogValue:MarketShapeExplanationCatalog, windowValues:readonly MarketShapeExplanationWindow[], resultValues:readonly unknown[]) {
  const catalog=validateMarketShapeExplanationCatalog(catalogValue);
  const windows=windowValues.map(w=>validateMarketShapeExplanationWindow(catalog,w));
  const index=new Map(windows.map(w=>[w.windowId,w]));
  if(index.size!==windows.length)throw new TypeError('Duplicate shape explanation window');
  const rowIds=windows.flatMap(w=>w.coverage.rowIds),expected=new Set(catalog.rows.map(r=>r.id));
  if(new Set(rowIds).size!==rowIds.length||rowIds.length!==expected.size||rowIds.some(id=>!expected.has(id)))
    throw new TypeError('Shape explanation window manifest is incomplete or duplicated');
  for(const dimension of new Set(windows.map(w=>w.dimension))){
    const fragments=windows.filter(w=>w.dimension===dimension).sort((a,b)=>a.fragment.ordinal-b.fragment.ordinal);
    if(fragments.some((w,i)=>w.fragment.count!==fragments.length||w.fragment.ordinal!==i+1))throw new TypeError('Shape explanation fragment sequence differs');
  }
  // Numeric coverage alone cannot prove that source provenance and limitations
  // were transmitted. Replay the complete manifest before accepting any result.
  decodeMarketShapeExplanationWindows(catalog,windows);
  const results=resultValues.map(value=>MarketShapeExplanationFragmentResultSchema.parse(value));
  if(new Set(results.map(r=>r.windowId)).size!==results.length)throw new TypeError('Duplicate shape explanation result');
  if(results.some(r=>!index.has(r.windowId)))throw new TypeError('Result refers to an unknown shape explanation window');
  const successful=results.flatMap(result=>result.status==='succeeded'?[validateMarketShapeExplanationFragment(catalog,index.get(result.windowId)!,result.output)]:[]);
  const failed=results.filter(r=>r.status==='failed').map(r=>({windowId:r.windowId,errorCode:r.errorCode}));
  const received=new Set(results.map(r=>r.windowId)),pending=windows.filter(w=>!received.has(w.windowId)).map(w=>w.windowId);
  successful.sort((a,b)=>windows.findIndex(w=>w.windowId===a.windowId)-windows.findIndex(w=>w.windowId===b.windowId));
  return freeze({explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,
    status:failed.length?'partial' as const:pending.length?'pending' as const:'ready-for-synthesis' as const,
    successful,failed,pending,synthesisStatus:'not-started' as const});
}
