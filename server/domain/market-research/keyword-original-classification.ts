import {SCENE_PATTERNS,W4_FAMILIES,detectW2Label} from '../../../shared/market-keyword-semantic-rules';
import {classifyKeywordDetailed,type KeywordCategory} from '../../../app/keyword-classifier';
import type {MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';
import {MarketKeywordOriginalClassificationSchema,type MarketKeywordOriginalClassification} from '../../../shared/market-keyword-original-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
// Rules restored from the original ZIP product-keyword-demand-analysis.ts.
const W4_LABELS: Partial<Record<KeywordCategory, string>> = {
  function: "功能",
  material_style: "材质风格",
  attribute_spec: "规格",
  benefit: "利益",
};



function detectW1(keyword: string, productSeed: string) {
  const text = keyword.toLowerCase();
  const seed = productSeed.trim().toLowerCase();
  if (seed && seed !== "product" && text.includes(seed)) return productSeed;
  if (/floor[\s-]?lamp|floorlamp/.test(text)) return "floor lamp";
  if (/standing lamp|stand up lamp|pole lamp|stand lamp/.test(text)) return "standing lamp";
  if (/tall floor|tall lamp/.test(text)) return "tall lamp";
  if (/\blamp\b/.test(text) && !/floor|standing|tall|table|desk|night/.test(text)) return "lamp";
  return productSeed;
}

function detectW3(keyword: string) {
  return SCENE_PATTERNS.find(entry => entry.pattern.test(keyword))?.label ?? null;
}


/** Pure, versioned read projection from stored facts. No new collection or model execution. */
export function buildKeywordOriginalClassification(facts:MarketKeywordFacts,productSeed:string):MarketKeywordOriginalClassification{
 const seed=productSeed.trim();
 if(!seed||seed.length>500)throw new TypeError('Invalid product seed');
 const display=(text:string)=>text.length>240?`${text.slice(0,237)}...`:text;
 const classification:MarketKeywordOriginalClassification['classification']={labels:{W1:[],W2:[],W3:[],W4:[]},clusters:[],assignments:[]};
 const meanings:MarketKeywordOriginalClassification['meanings']=[];
 function label(d:'W1'|'W2'|'W3'|'W4',text:string|null){
  if(!text)return [];
  const labelId=`rule-${d}:${digest(text)}`;
  if(!classification.labels[d].some(l=>l.labelId===labelId))classification.labels[d].push({labelId,label:display(text),definition:`规则分类：${text}；产品维度沿用核心名归并，其他维度匹配原词；不代表买家人口比例。`});
  return [labelId];
 }
 for(const member of facts.members){
  const {category}=classifyKeywordDetailed(member.keyword,{productNouns:[seed]});meanings.push({keywordId:member.keywordId,category});
  if(category==='brand_competitor'){
   classification.assignments.push({keywordId:member.keywordId,W1:[],W2:[],W3:[],W4:[],clusterId:null});continue;
  }
  const w1=detectW1(member.keyword,seed),w2=detectW2Label(member.keyword,category),w3=detectW3(member.keyword)??(category==='scenario'?'场景词':null);
  const w4=W4_FAMILIES.find(r=>r.pattern.test(member.keyword))?.label??W4_LABELS[category]??null;
  const clusterId=`rule-cluster:${digest([w1,w3,w2])}`,name=`${w1} · ${w3??'通用'}${w2?` · ${w2}`:''}`;
  if(!classification.clusters.some(c=>c.clusterId===clusterId))classification.clusters.push({clusterId,label:display(name),definition:`按产品、场景、人群组合分组：${name}；功能属性保留在成员标签中。`});
  classification.assignments.push({keywordId:member.keywordId,W1:label('W1',w1),W2:label('W2',w2),W3:label('W3',w3),W4:label('W4',w4),clusterId});
 }
 const basis={version:'keyword-original-classification/v1' as const,factsId:facts.factsId,productSeed:seed,classification,meanings};
 return MarketKeywordOriginalClassificationSchema.parse({...basis,identity:`keyword-original:${digest(basis)}`});
}
