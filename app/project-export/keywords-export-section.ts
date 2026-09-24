import { z } from "zod";
import { buildKeywordComparisonMatrix,buildKeywordDemandAnalysis,type KeywordDemandSources } from "../keyword-demand-analysis";
import { buildKeywordLaunchConclusions } from "../keyword-demand-conclusions";
import { keywordMeaningTaxonomy } from "../keyword-classifier";
import type { ExportModuleContext } from "./export-module-context";
import type { ExportBlock,ExportSection } from "./export-contracts";
import { buildExportRuleTrace } from "./export-rule-trace";

const num=z.number().finite().nullable();
const rowSchema=z.object({keyword:z.string(),trafficShare:num,searchVolume:num,abaRank:num,cpcMedian:num,cpcLow:num,cpcHigh:num,
  naturalRatio:num,trafficDependency:z.string().nullable(),organicRank:z.string().nullable(),rankEvolution:z.string().nullable(),keywordHealth:z.string().nullable(),
  top3ClickShare:num,top3ConversionShare:num,clickConversionRate:num});
const analysisSchema=z.object({asin:z.string(),marketplace:z.string(),fetchedAt:z.string(),status:z.enum(["ready","empty","error"]),
  statusMessage:z.string().optional(),dataNotice:z.string().nullable().optional(),totalKeywordsInPeriod:num,topKeywordsAnalyzed:z.number(),keywords:z.array(rowSchema),
  queryWindow:z.object({time_type:z.string(),time_value:z.string(),listingSearch:z.boolean()}).nullable().optional()});
const enrichSchema=z.object({keyword:z.string(),fetchedAt:z.string(),status:z.enum(["ready","partial","error"]),statusMessage:z.string().optional(),
  searchTrend:z.array(z.object({month:z.string(),volume:z.number().finite(),abaRank:z.number().finite()})),
  bidLow:num,bidMedian:num,bidHigh:num,clickConversionRate:num,top3ClickShare:num,top3ConversionShare:num});
const record=(v:unknown):Record<string,unknown>=>v==null?{}:z.record(z.string(),z.unknown()).parse(v);
const str=(v:unknown)=>v==null||v===""?"—":String(v);
const cell=(v:unknown)=>({text:str(v)});
const pct=(v:number|null|undefined)=>v==null?"—":`${v.toFixed(2)}%`;
const table=(title:string,columns:string[],rows:unknown[][]):ExportBlock=>({kind:"table",title,columns,rows:rows.map(row=>row.map(cell))});

export function buildKeywordsExportSection(context:ExportModuleContext):ExportSection {
  const missing:ExportSection={id:"keywords",title:"关键词调研",status:"missing",blocks:[{kind:"text",text:"暂无已发布的关键词结果；不会重新查询流量词或生成分析。"}]};
  const stage=context.version?.stageOutputs.keywords;
  if(!stage||!("data"in stage))return missing;
  const data=record(stage.data),rawAnalysis=record(data.analysisByAsin),rawEnrich=record(data.enrichmentByKeyword);
  const analysisByAsin:NonNullable<KeywordDemandSources["analysisByAsin"]>={};
  const enrichmentByKeyword:NonNullable<KeywordDemandSources["enrichmentByKeyword"]>={};
  for(const asin of context.asins) {
    if(rawAnalysis[asin]===undefined)continue;
    const item=analysisSchema.parse(rawAnalysis[asin]);
    if(item.asin!==asin||item.marketplace!==context.marketplace)throw new Error("关键词来源范围不匹配");
    analysisByAsin[asin]=item;
    for(const row of item.keywords) {
      const key=row.keyword.trim().toLowerCase();if(rawEnrich[key]===undefined)continue;
      const enrichment=enrichSchema.parse(rawEnrich[key]);
      if(enrichment.keyword.trim().toLowerCase()!==key)throw new Error("关键词补充来源不匹配");
      enrichmentByKeyword[key]=enrichment;
    }
  }
  const products=context.asins.map(asin=>{
    const p=record(context.version?.catalog.find(item=>record(item).asin===asin));
    return {asin,brand:typeof p.brand==="string"?p.brand:"品牌未记录",title:typeof p.title==="string"?p.title:"",
      subRankCategory:typeof p.subRankCategory==="string"?p.subRankCategory:"",image:typeof p.image==="string"?p.image:undefined,
      price:typeof p.price==="number"?p.price:null};
  });
  const sources={analysisByAsin,enrichmentByKeyword};
  const analysis=buildKeywordDemandAnalysis(products,sources);
  const matrix=buildKeywordComparisonMatrix(products,{sources,limit:Number.MAX_SAFE_INTEGER});
  const conclusions=buildKeywordLaunchConclusions(analysis,products,{projectId:context.projectId,organizationId:context.organizationId,marketplace:context.marketplace},sources);
  const blocks:ExportBlock[]=[
    {kind:"text",text:analysis.hasData?`${analysis.headline}\n${analysis.summaryInsight}`:"当前已保存关键词结果为空或未就绪。"},
    table("来源与覆盖范围",["ASIN","来源时间","状态","说明","原始周期","期间关键词总数","已有词条数"],context.asins.map(asin=>{
      const v=analysisByAsin[asin];return [asin,v?.fetchedAt,v?.status,v?.dataNotice||v?.statusMessage,
        v?.queryWindow?`${v.queryWindow.time_type} · ${v.queryWindow.time_value} · listingSearch=${v.queryWindow.listingSearch}`:"来源未记录",
        v?.totalKeywordsInPeriod,v?.keywords.length];
    })),
    table("分类分组汇总",["分组","词条数","占比"],analysis.categoryGroups.map(v=>[v.label,v.keywordCount,pct(v.sharePct)])),
    table("标签分布概览",["分组","分类","词条数","占比","说明","洞察"],analysis.categories.map(v=>[v.groupLabel,v.label,v.keywordCount,pct(v.sharePct),v.description,v.insight])),
    table("竞品关键词结构对比（全部分类）",["ASIN","品牌","分类","词条数","占比"],analysis.competitorBreakdown.flatMap(v=>v.mix.map(m=>[v.asin,v.brand,m.label,m.count,pct(m.sharePct)]))),
    table("完整流量词对比",["关键词","分类","月搜索量","搜索量月份","建议竞价低/中/高","点击转化率","ABA排名","Top3点击","Top3转化","覆盖竞品",...matrix.competitors.map(p=>p.asin)],
      matrix.rows.map(v=>[v.keyword,v.categoryLabel,v.searchVolume,v.searchVolumeMonth,[v.bidLow,v.bidMedian,v.bidHigh].map(str).join(" / "),
        pct(v.clickConversionRate),v.abaRank,pct(v.top3ClickShare),pct(v.top3ConversionShare),`${v.coverageCount}/${v.coverageTotal}`,...v.cells.map(c=>pct(c.trafficShare))])),
  ];
  if(!analysis.hasData)return {id:"keywords",title:"关键词调研",status:"missing",
    blocks:[...blocks.slice(0,2),{kind:"text",text:"关键词洞察暂无已生成结果，不给出机会等级或产品配置结论。"}]};
  for(const row of matrix.rows)if(row.searchTrend.length) {
    blocks.push({kind:"chart",title:`${row.keyword} · 月搜索量（全部已有月份）`,labels:row.searchTrend.map(p=>p.month),series:[{label:"月搜索量",values:row.searchTrend.map(p=>p.volume)}]},
      {kind:"chart",title:`${row.keyword} · ABA 排名`,labels:row.searchTrend.map(p=>p.month),series:[{label:"ABA排名（越小越靠前）",values:row.searchTrend.map(p=>p.abaRank>0?p.abaRank:null)}]});
  }
  blocks.push({kind:"text",text:`关键词洞察\n${conclusions.headline}\n${conclusions.verdict.gradeLabel} · ${conclusions.verdict.matrixLabel}\n${conclusions.verdict.productProposal}`},
    {kind:"text",text:conclusions.dataGaps.join("\n")||"已有数据限制见各来源记录。"});
  for(const section of conclusions.sections)blocks.push(table(section.title,["维度","结论","已通过核验的内容","判定引用"],section.items.map(v=>[v.label,v.value,v.acceptedValue,v.ruleDecisionIds?.join("；")])));
  blocks.push(table("功能需求分层",["关键词","分层","搜索量","覆盖数","产品动作"],conclusions.functionMatrix.map(v=>[v.keyword,v.type,v.volume,v.coverage,v.action])),
    table("高频需求组合词",["关键词","组合要素","月搜索量"],conclusions.keywordCombos.map(v=>[v.keyword,v.elements,v.volume])),
    table("关键词分类标准",["分类","说明","分组","使用提示","示例"],keywordMeaningTaxonomy.map(v=>[v.label,v.description,v.group,v.listingHint,v.examples.join("、")])),
    ...buildExportRuleTrace(conclusions.ruleTrace));
  return {id:"keywords",title:"关键词调研",status:analysis.hasData?"ready":"missing",blocks};
}
