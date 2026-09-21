import {z} from 'zod';
import {MarketShapeSuggestionOutputSchema, type MarketShapeSuggestionInput, type MarketTextSpanRef} from '../../../shared/market-semantic-contracts';
import {MarketShapeSpanNormalizationSchema, type MarketShapeSpanNormalization} from '../../../shared/agent-contracts';
import {marketSemanticValidationRuleId} from './semantic-validation-rules';
export const MARKET_SHAPE_SPAN_NORMALIZATION_VERSION = 'market-shape-exact-span/v1' as const;
export function splitsSurrogate(text:string,position:number):boolean {
 return position>0&&position<text.length&&/[\uD800-\uDBFF]/.test(text[position-1])&&/[\uDC00-\uDFFF]/.test(text[position]);
}
export function marketSpanFailure(value:MarketTextSpanRef,text:string):string|undefined {
 if(!value.quote.trim())return 'span_empty_quote';
 if(splitsSurrogate(text,value.start)||splitsSurrogate(text,value.end))return 'span_surrogate_boundary';
 if(value.start<0||value.start>=value.end||value.end>text.length)return 'span_out_of_range';
 if(text.slice(value.start,value.end)!==value.quote)return 'span_quote_mismatch';
}
/** Live shape outputs only. Call full semantic validation after this coordinate-only operation. */
export function normalizeLiveMarketShapeSpans(input:MarketShapeSuggestionInput,candidate:unknown) {
 const parsed=MarketShapeSuggestionOutputSchema.safeParse(candidate);
 if(!parsed.success)throw new z.ZodError(parsed.error.issues.map(issue=>({...issue,message:'invalid_schema'})));
 const output=parsed.data,provenance:MarketShapeSpanNormalization[]=[];
 const fail=(reason:string,path:(string|number)[]):never=>{throw new z.ZodError([{code:'custom',message:reason,path,params:{ruleId:marketSemanticValidationRuleId(reason)}}]);};
 for(const [pi,product] of output.products.entries()) {
  const owner=input.products.find(p=>p.productId===product.productId&&p.asin===product.productId);
  const fields=owner?[...(owner.title.state==='known'?[owner.title.value]:[]),...(owner.parameters.state==='known'?owner.parameters.value:[])]:[];
  const d=product.decision;
  const groups=d.status==='unknown'?[{evidence:d.evidence,path:['products',pi,'decision','evidence']}]:d.candidates.map((c,ci)=>({evidence:c.evidence,path:['products',pi,'decision','candidates',ci,'evidence']}));
  for(const group of groups) for(const [si,span] of group.evidence.entries()) {
   const path=[...group.path,si];
   const field=fields.find(f=>f.refId===span.refId&&f.recordId===product.productId);
   if(!field)fail('span_unknown_or_foreign_reference',path);
   const text=field!.text,reason=marketSpanFailure(span,text);
   if(!reason)continue;
   // Boundary-splitting coordinates remain protocol failures, even if another match exists.
   if(reason==='span_surrogate_boundary'||!span.quote.trim())fail(reason,path);
   const start=text.indexOf(span.quote);
   if(start<0)fail('span_quote_not_found',path);
   if(text.indexOf(span.quote,start+1)>=0)fail('span_quote_ambiguous',path);
   const end=start+span.quote.length;
   if(splitsSurrogate(text,start)||splitsSurrogate(text,end))fail('span_surrogate_boundary',path);
   // Validation persists products in input ASIN order. Audit paths address that
   // final output; failure diagnostics above still address the submitted order.
   const persistedPath=[...path];persistedPath[1]=input.products.findIndex(p=>p.productId===product.productId);
   provenance.push(MarketShapeSpanNormalizationSchema.parse({path:persistedPath,refId:span.refId,oldStart:span.start,oldEnd:span.end,newStart:start,newEnd:end,ruleVersion:MARKET_SHAPE_SPAN_NORMALIZATION_VERSION}));
   span.start=start;span.end=end;
  }
 }
 return {output,provenance};
}
export function marketShapeSpanRepairGuidance():readonly string[] {
 return ['Citations must use the already referenced original title or parameter field of the same product ASIN. Preserve quote, refId and decision. Offsets count UTF-16 code units and must not split a surrogate pair. Valid original offsets stay unchanged. Incorrect coordinates may be corrected only when the unchanged literal quote occurs exactly once in that same field. Do not trim, translate, change case, use fuzzy matching, switch fields or ASINs, or turn a citation protocol error into business unknown.'];
}
