import { z } from "zod";
import { resolveRemarkForGalleryImage } from "../lib/listing-image-remark-resolution";
import type { ExportModuleContext } from "./export-module-context";
import type { ExportBlock, ExportSection } from "./export-contracts";

const listingSchema = z.object({
  asin:z.string(),marketplace:z.string(),fetchedAt:z.string().optional(),status:z.string().optional(),statusMessage:z.string().optional(),
  mainImage:z.string().nullable().optional(),galleryImages:z.array(z.string()).optional(),previousGalleryImages:z.array(z.string()).optional(),
}).passthrough();
const remarkSchema=z.object({remark:z.string(),image_types:z.array(z.string()),confidence:z.string(),imageUrl:z.string().optional()});
const map=(value:unknown):Record<string,unknown>=>value==null?{}:z.record(z.string(),z.unknown()).parse(value);
const text=(value:unknown)=>({text:value==null||value===""?"—":String(value)});

export function buildListingImagesExportSection(context:ExportModuleContext):ExportSection {
  const version=context.version;
  const missing:ExportSection={id:"listing-images",title:"主副图分析",status:"missing",blocks:[{kind:"text",text:"暂无已发布的主副图结果；本次导出不会发起图片分析。"}]};
  if(!version)return missing;
  const listing=version.stageOutputs.listing,remarks=version.stageOutputs.image_remarks;
  const data=listing&&"data"in listing?map(listing.data):{};
  const notes=remarks&&"data"in remarks?map(remarks.data):{};
  const content=map(data.contentByAsin),remarksByAsin=map(notes.remarksByAsin),outcomes=map(notes.outcomesByAsin);
  const blocks:ExportBlock[]=[{kind:"text",text:"商品图使用在线原始地址；保留全部已有图片及备注，不受页面九列显示限制。图片以后可能变化或失效，正文备注已固定。"}];
  let count=0;
  for(const asin of context.asins) {
    const product=map(version.catalog.find(value=>map(value).asin===asin));
    const item=content[asin]===undefined?null:listingSchema.parse(content[asin]);
    if(item&&(item.asin!==asin||item.marketplace!==context.marketplace))throw new Error("主副图来源范围不匹配");
    const gallery=item?.galleryImages?.length?item.galleryImages:item?.mainImage?[item.mainImage]:typeof product.image==="string"&&product.image?[product.image]:[];
    const rawNotes=remarksByAsin[asin]===undefined?[]:z.array(z.unknown()).parse(remarksByAsin[asin]);
    const rawOutcomes=outcomes[asin]===undefined?[]:z.array(z.unknown()).parse(outcomes[asin]);
    const rows=gallery.map((url,index)=>{
      const current=resolveRemarkForGalleryImage(url,index,item?.previousGalleryImages,i=>rawNotes[i]==null?null:remarkSchema.parse(rawNotes[i]));
      const overlay=!current?version.imageRemarkOverlay?.find(note=>note.asin===asin&&note.index===index&&note.imageUrl===url):undefined;
      const outcome=map(rawOutcomes[index]);
      const reason=typeof outcome.reason==="string"?outcome.reason:typeof outcome.status==="string"?outcome.status:"尚无图片分析结果";
      count++;
      return [text(index+1),{text:index===0?"主图":/PKplay-button/i.test(url)?"视频封面":"辅图",imageUrl:url,href:url},
        text(current?.remark??overlay?.remark??reason),text(current?.image_types.join(" · ")??overlay?.imageTypes.join(" · ")),
        text(current?.confidence??overlay?.confidence),text(overlay?`${overlay.source.sourceKind==="supplemental-analysis"?"补充分析":"历史备注"} · ${overlay.source.capturedAt}`:item?.fetchedAt??version.catalogEvidence?.sourceUpdatedAt),
        text(current||overlay?typeof outcome.status==="string"&&outcome.status!=="ready"?`当前分析未完成，保留已有结果：${reason}`:"已有备注":reason)];
    });
    blocks.push({kind:"text",text:`${asin} · ${typeof product.brand==="string"?product.brand:"品牌未记录"} · ${item?.statusMessage??item?.status??"图册无结果，使用目录主图（如有）"}`},
      {kind:"table",title:`${asin} · 全部主副图`,columns:["图片序号","图片","完整视觉结构摘要","图片类型","置信度","来源时间","状态"],rows});
  }
  return {id:"listing-images",title:"主副图分析",status:count?"ready":"missing",blocks:count?blocks:[...missing.blocks,...blocks]};
}
