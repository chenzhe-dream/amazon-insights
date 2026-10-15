import {projectBasicOverviewTableMetrics} from '../domain/market-research/overview-basic-table';
import { createHash } from "node:crypto";
import {marketSiteCurrency,normalizeMarketSite} from '../../shared/market-sites';
import { MarketOverviewReportSchema, type MarketOverviewReport, type MarketResearchIssue, type MarketResearchScope } from "../../shared/market-research-contracts";
import { ConnectorError, type ConnectorResult, type RemoteMcpConnector } from "../connectors/connector-contract";

type Dataset = MarketResearchIssue["dataset"];
const messages: Record<MarketResearchIssue["code"], string> = {
  "quota-exhausted":"数据源额度已耗尽，新采集已暂停；已保存报告仍可查看", "local-admission":"本地调用队列暂满或策略限制",
  configuration:"数据源尚未配置", authentication:"数据源认证失败", "rate-limit":"数据源限流，请稍后重试",
  timeout:"类目数据采集超时", "upstream-temporary":"数据源暂时不可用", "upstream-permanent":"数据源拒绝了本次请求",
  "malformed-response":"数据源返回格式无法识别", empty:"该类目和月份没有可用数据", "scope-mismatch":"返回的类目与请求不匹配",
  interrupted:"任务已中断，请重试",
};
export class MarketResearchCollectionError extends Error {
  constructor(readonly issue: MarketResearchIssue) { super(issue.message); }
}
function issue(dataset: Dataset, code: MarketResearchIssue["code"], retryable=false): MarketResearchIssue {
  return {dataset,code,message:messages[code],retryable};
}
export function marketResearchFailure(error: unknown, dataset: Dataset="research"): MarketResearchIssue {
  if(error instanceof MarketResearchCollectionError) return error.issue;
  if(error instanceof ConnectorError) return issue(dataset,error.code,error.retryable);
  if(error instanceof Error && ["TimeoutError","AbortError"].includes(error.name)) return issue(dataset,"timeout",true);
  return issue(dataset,"malformed-response");
}
function record(value: unknown): Record<string,unknown> {
  return value!==null && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function unwrap(value: unknown, dataset: Dataset): unknown {
  const body=record(value);
  if(body.code!==undefined && body.code!=="OK") throw new MarketResearchCollectionError(issue(dataset,"upstream-permanent"));
  return body.data ?? value;
}
function number(value: unknown): number|null {
  if(typeof value!=="number" && typeof value!=="string") return null;
  if(typeof value==="string" && !value.trim()) return null;
  const parsed=Number(value);
  return Number.isFinite(parsed) && parsed>=0 ? parsed : null;
}
function assertScope(row: Record<string,unknown>, nodeId:string, nodeIdPath:string, month:string, dataset:Dataset, scope:MarketResearchScope) {
  if((row.nodeId!==undefined && String(row.nodeId)!==nodeId) ||
    (row.nodeIdPath!==undefined && String(row.nodeIdPath)!==nodeIdPath) ||
    (row.marketplace!==undefined && normalizeMarketSite(String(row.marketplace))!==scope.marketplace) ||
    (row.currency!==undefined && row.currency!==marketSiteCurrency(scope.marketplace)) ||
    (month!=='last30' && row.month!==undefined && String(row.month).replaceAll("-","")!==month.replaceAll("-",""))) {
    throw new MarketResearchCollectionError(issue(dataset,"scope-mismatch"));
  }
}

function readMetrics(research: Record<string, unknown>, statistics: Record<string, unknown>, scope: MarketResearchScope) {
  const metric=(key:string,fallback=key)=>number(research[key])??number(statistics[fallback]);
  const cr=`top${scope.headTopN}`;
  const neu=`l${scope.newProductMonths}`;
  const rating=metric("avgRating");
  return {
    sampleProducts:number(research.topProducts)??metric("products"),brands:metric("brands"),sellers:metric("sellers"),
    totalUnits:number(research.totalUnits),totalRevenue:number(research.totalRevenue),
    avgPrice:metric("avgPrice"),avgUnits:metric("avgUnits"),avgRatings:metric("avgRatings"),avgRating:rating!==null&&rating<=5?rating:null,
    productConcentrationRaw:number(research[`${cr}ProductCrn`]),brandConcentrationRaw:number(research[`${cr}BrandCrn`]),sellerConcentrationRaw:number(research[`${cr}SellerCrn`]),
    newCount:metric(`${neu}NewCount`,"newProducts"),newAvgPrice:metric(`${neu}NewAvgPrice`,"newAvgPrice"),newAvgUnits:metric(`${neu}NewAvgSales`,"newAvgUnits"),
  };
}

export async function collectMarketOverview(input: {
  scope: MarketResearchScope; organizationId:string; jobId:string; connector:RemoteMcpConnector; signal?:AbortSignal;
  now?:()=>Date; timeoutMs?:number;
}): Promise<MarketOverviewReport> {
  const {scope}=input;
  const signal=AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(input.timeoutMs??60_000)]);
  signal.throwIfAborted();
  const evidence: MarketOverviewReport["evidence"]=[];
  const issues: MarketResearchIssue[]=[];
  const addEvidence=(dataset:Dataset, result:ConnectorResult)=>evidence.push({
    dataset,operation:result.source.operation as MarketOverviewReport["evidence"][number]["operation"],
    fetchedAt:result.source.fetchedAt,contentHash:createHash("sha256").update(JSON.stringify(result.data)).digest("hex"),
  });
  const execute=(operation:string, request:Record<string,unknown>)=>input.connector.execute({operation,input:{request},signal,
    governorScope:{organizationId:input.organizationId,jobId:input.jobId}});
  const nodeId=scope.nodeQuery.split(":").at(-1)!;
  let nodeIdPath=scope.nodeQuery;
  let categoryName="";
  if(!scope.nodeQuery.includes(":")) {
    try {
      const result=await execute("product_node",{marketplace:scope.marketplace,keyword:nodeId,...(scope.month==='last30'?{}:{month:scope.month.replaceAll("-","")})});
      const payload=unwrap(result.data,"node");
      const nodes=Array.isArray(payload)?payload:[payload];
      const matches=nodes.map(record).filter(row=>/^\d+(?::\d+)*$/.test(String(row.nodeIdPath??"")) && String(row.nodeIdPath).split(":").at(-1)===nodeId);
      if(!matches.length) throw new MarketResearchCollectionError(issue("node","scope-mismatch"));
      nodeIdPath=String(matches[0].nodeIdPath);
      categoryName=String(matches[0].nodeLabelPath??"").slice(0,300);
      addEvidence("node",result);
    } catch(error) {throw new MarketResearchCollectionError(marketResearchFailure(error,"node"));}
  }
  signal.throwIfAborted();
  const request={marketplace:scope.marketplace,nodeIdPath,...(scope.month==='last30'?{}:{month:scope.month.replaceAll("-","")}),newProduct:scope.newProductMonths};
  const results=await Promise.allSettled([
    execute("market_research",{...request,topNum:scope.headTopN,page:1,size:10}),
    execute("market_research_statistics",{...request,topN:scope.headTopN}),
  ]);
  // A deadline on one endpoint must not discard another endpoint's completed
  // result. An explicit worker cancellation still aborts the entire collection.
  input.signal?.throwIfAborted();
  let research:Record<string,unknown>={};
  let statistics:Record<string,unknown>={};
  for(const [index,dataset] of (["research","statistics"] as const).entries()) {
    const result=results[index];
    if(result.status==="rejected") {issues.push(marketResearchFailure(result.reason,dataset));continue;}
    try {
      const payload=record(unwrap(result.value.data,dataset));
      let selected:Record<string,unknown>;
      if(dataset==="research") {
        const items=Array.isArray(payload.items)?payload.items.map(record):[];
        const matches=items.filter(row=>String(row.nodeId??"")===nodeId || String(row.nodeIdPath??"")===nodeIdPath);
        if(matches.length!==1) throw new MarketResearchCollectionError(issue(dataset,items.length?"scope-mismatch":"empty"));
        selected=matches[0];
      } else { selected=payload; }
      if(!Object.keys(selected).length) throw new MarketResearchCollectionError(issue(dataset,"empty"));
      assertScope(selected,nodeId,nodeIdPath,scope.month,dataset,scope);
      const sourceMetrics=dataset==="research"?readMetrics(selected,{},scope):readMetrics({},selected,scope);
      if(Object.values({...sourceMetrics,...projectBasicOverviewTableMetrics(dataset==='research'?selected:{},dataset==='statistics'?selected:{},scope)}).every(value=>value===null)) {
        throw new MarketResearchCollectionError(issue(dataset,"malformed-response"));
      }
      if(dataset==="research") research=selected; else statistics=selected;
      addEvidence(dataset,result.value);
    } catch(error) {issues.push(marketResearchFailure(error,dataset));}
  }
  // The statistics endpoint is requested with the same explicit node/month. Its
  // missing identity fields are not replaced with the first research search hit.
  const metrics=readMetrics(research,statistics,scope);
  const tableMetrics=projectBasicOverviewTableMetrics(research,statistics,scope);
  if(Object.values({...metrics,...tableMetrics}).every(value=>value===null)) throw new MarketResearchCollectionError(issues[0]??issue("research","empty"));
  return MarketOverviewReportSchema.parse({schemaVersion:"market-overview/v1",scope,nodeId,nodeIdPath,
    categoryName:String(research.nodeLabelName??research.nodeLabelPath??categoryName).slice(0,300),currency:marketSiteCurrency(scope.marketplace),
    collectedAt:(input.now?.()??new Date()).toISOString(),metrics,tableMetrics,evidence,issues,boundaries:[
      "指标基于数据源返回的类目样本，样本商品数不等于全市场商品数。",
      `头部口径 CR${scope.headTopN} 与新品窗口 ${scope.newProductMonths} 个月分别计算。集中度与新品占比沿用原版：研究接口0～1的比例乘100，统计接口百分数直接显示。`,
      "本表保存本次基础采集指标；详细分布、历史趋势和评分见对应总览报告。",
      "单月数据不能证明市场增长、需求旺季、盈利能力或立项可行性。",
    ]});
}
