/** Numeric distribution buckets; unknown labels never count as low or high. */
export function parseNumericRange(label:string):{min:number;max:number}|null {
 const s=label.normalize('NFKC').trim().replace(/,/g,'').replace(/(?:reviews?|ratings?|条|个|评分数|评论数)/gi,'').trim();
 let m=s.match(/^(\d+(?:\.\d+)?)\s*[-–—~至到]\s*(\d+(?:\.\d+)?)$/);
 if(m){const min=Number(m[1]),max=Number(m[2]);return min<=max?{min,max}:null;}
 m=s.match(/^(?:<|≤|<=|少于|低于)\s*(\d+(?:\.\d+)?)$/)??s.match(/^(\d+(?:\.\d+)?)\s*(?:以下|以内)$/);
 if(m)return {min:0,max:Number(m[1])};
 m=s.match(/^(?:>|≥|>=|超过|高于)\s*(\d+(?:\.\d+)?)$/)??s.match(/^(\d+(?:\.\d+)?)\s*(?:以上|及以上|\+)$/);
 if(m)return {min:Number(m[1]),max:Infinity};
 return null;
}
export const isLowReviewRange=(label:string)=>{const r=parseNumericRange(label);return r!==null&&r.max<=300;};
export const isHighReviewRange=(label:string)=>{const r=parseNumericRange(label);return r!==null&&r.min>=500;};
