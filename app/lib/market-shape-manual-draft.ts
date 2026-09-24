import type {z} from 'zod';
import type {MarketSemanticLabelSchema} from '../../shared/market-semantic-contracts';

type ShapeLabel=z.infer<typeof MarketSemanticLabelSchema>;
const manualBasis='由用户在 TOP 销售表人工标注；未单独记录判断依据';
export const normalizeManualShapeName=(value:string)=>value.trim().replace(/\s+/g,' ');

/** Shape names are chosen after products arrive. The run's source catalog stays frozen;
 * each saved manual revision has its own explicit labels and assignments. */
export function buildManualShapeCatalog(prior:readonly ShapeLabel[],selected:readonly string[],names:Readonly<Record<string,string>>):{
 labels:ShapeLabel[];
 assignments:Array<{asin:string;labelId:string}>;
}{
 const labels=[...prior],byName=new Map(prior.map(label=>[normalizeManualShapeName(label.label),label]));
 const chosen=new Map<string,string>();
 for(const asin of selected){
  const name=normalizeManualShapeName(names[asin]??'');
  if(name.length>60)throw new Error('商品形态名称不能超过 60 字。');
  if(name)chosen.set(asin,name);
 }
 const usedIds=new Set(labels.map(label=>label.labelId));
 let next=1;
 for(const name of [...new Set(chosen.values())].sort((a,b)=>a.localeCompare(b,'zh-CN'))){
  if(byName.has(name))continue;
  if(labels.length>=32)throw new Error('一个统计版本最多保存 32 个商品形态。');
  while(usedIds.has(`manual-shape-${next}`))next++;
  const label={labelId:`manual-shape-${next++}`,label:name,definition:manualBasis};
  labels.push(label);byName.set(name,label);usedIds.add(label.labelId);
 }
 return {labels,assignments:selected.flatMap(asin=>{
  const name=chosen.get(asin);return name?[{asin,labelId:byName.get(name)!.labelId}]:[];
 })};
}
