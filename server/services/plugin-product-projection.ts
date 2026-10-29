import {SorftimeShapeProductSchema,type SorftimeShapeProduct} from '../../shared/market-shape-sorftime-contracts';
import {MarketShapeProductImageUrlSchema} from '../../shared/market-shape-product-image-contracts';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const number=(v:unknown,integer=false)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER&&(!integer||Number.isSafeInteger(v))?v:null;
const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.slice(0,4000):null;
/** bsr is a main-category rank. Only an exact node ID match establishes a leaf rank. */
function pluginLeafCategory(b:Record<string,unknown>,nodeId:string){
 const matches=(Array.isArray(b.bsrList)?b.bsrList:[]).map((value,index)=>({row:obj(value),index})).filter(({row})=>(typeof row.id==='string'||typeof row.id==='number'&&Number.isSafeInteger(row.id))&&String(row.id)===nodeId);
 if(matches.length!==1)return null;
 const {row,index}=matches[0],rank=number(row.rank,true);
 return {index,rank:rank!==null&&rank>0?rank:null,label:text(row.label)??text(row.text)};
}
function pluginListedAt(value:unknown,collectedAt:string){
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0||value>Date.parse(collectedAt))return null;
 const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString().slice(0,10):null;
}
export function pluginProduct(p:SorftimeShapeProduct,b:Record<string,unknown>,nodeId:string,collectedAt:string):SorftimeShapeProduct{
 const image=[b.image,b.image_zoom].map(v=>MarketShapeProductImageUrlSchema.safeParse(v)).find(v=>v.success&&v.data);
 const leaf=pluginLeafCategory(b,nodeId),path=typeof b.node_id_path==='string'?b.node_id_path.split(':'):[],labels=typeof b.node_label_path==='string'?b.node_label_path.split(':'):[];
 const category=leaf?.label??(path.at(-1)===nodeId&&path.length===labels.length?text(labels.at(-1)):null),nation=obj(b.seller_dto).nation_code;
 // profit has no confirmed unit or meaning in this export; grossProfitMargin stays unknown.
 return SorftimeShapeProductSchema.parse({...Object.fromEntries(Object.keys(p).map(k=>[k,null])),asin:p.asin,sourceIndex:p.sourceIndex,title:text(b.title),brand:text(b.brand),price:(number(b.price)??0)>0?number(b.price):null,units:number(b.units,true),revenue:number(b.amount),sourceRank:leaf?.rank??null,rating:typeof b.rating==='number'&&b.rating>=0&&b.rating<=5?b.rating:null,ratingCount:number(b.reviews,true),sellerName:text(b.seller_name),sellerType:text(b.seller_type),imageUrl:image?.success?image.data:null,listedAt:pluginListedAt(b.available,collectedAt),sellerOrigin:typeof nation==='string'&&/^[a-z]{2}$/i.test(nation)?nation.toUpperCase():null,categoryRank:leaf?.rank&&category?`${category} (Rank: ${leaf.rank})`.slice(0,4000):null,productCategory:category});
}
