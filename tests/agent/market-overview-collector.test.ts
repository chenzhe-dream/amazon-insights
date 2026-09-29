import assert from "node:assert/strict";
import test from "node:test";
import { collectMarketOverview } from "../../server/services/market-overview-collector";
import { ConnectorError, type ConnectorRequest, type RemoteMcpConnector } from "../../server/connectors/connector-contract";
import type { MarketResearchScope } from "../../shared/market-research-contracts";

const scope: MarketResearchScope = {marketplace:"US",nodeQuery:"123:456",month:"2026-08",headTopN:10,newProductMonths:6};
const actor = {organizationId:"org-a",jobId:"job-a"};
function connector(handler:(request:ConnectorRequest)=>unknown): RemoteMcpConnector {
  return {id:"sellerSprite",probe:async()=>{throw new Error("No probe expected");},execute:async request=>({data:await handler(request) as Record<string,unknown>,source:{connectorId:"sellerSprite",operation:request.operation,fetchedAt:"2026-09-12T00:00:00.000Z",attemptCount:1}})};
}
function research(extra={}) {return {code:"OK",data:{items:[{nodeId:"456",nodeIdPath:"123:456",nodeLabelName:"Floor Lamps",currency:"USD",topProducts:100,totalUnits:1000,avgPrice:20,...extra}]}};}

test('basic table saves original fields with the selected head divisor and percentage conventions',async()=>{
 const result=await collectMarketOverview({scope,...actor,connector:connector(r=>r.operation==='market_research'?research({top10ProductSales:1000,top10ProductRevenue:20000,avgRevenue:300,avgBsr:0,avgSellers:1.2,top10ProductCrn:.42,top10BrandCrn:60,l6NewRatio:.2,fbaProportion:90,amazonSelfProportion:0,fbmProportion:10,totalProducts:800,returnRatio:2.3,avgReturnRatio:3}):{data:{hlAvgBsr:120,hlAvgUnits:999,avgRevenue:888}})});
 assert.deepEqual(result.tableMetrics,{hlAvgUnits:100,hlAvgRevenue:2000,avgRevenue:300,avgBsr:0,hlAvgBsr:120,avgSellers:1.2,productCrn:42,brandCrn:60,sellerCrn:null,newRatio:20,fbaProportion:90,amazonSelfProportion:0,fbmProportion:10,totalProducts:800,returnRatio:2.3,avgReturnRatio:3});
});

test('basic table does not invent missing fields or mix invalid scope and fallback units',async()=>{
 const result=await collectMarketOverview({scope,...actor,connector:connector(r=>r.operation==='market_research'?research({avgRevenue:'',avgBsr:false,l6NewRatio:null}):{data:{hlAvgUnits:0,newProductProportion:.3,avgRevenue:12}})});
 assert.equal(result.tableMetrics?.hlAvgUnits,0); assert.equal(result.tableMetrics?.newRatio,.3);
 assert.equal(result.tableMetrics?.avgBsr,null); assert.equal(result.tableMetrics?.totalProducts,null);
 const mismatch=await collectMarketOverview({scope,...actor,connector:connector(r=>r.operation==='market_research'?research():{data:{nodeId:'999',hlAvgUnits:777}})});
 assert.equal(mismatch.tableMetrics?.hlAvgUnits,null);
});
test("market overview retains scope and missing values without inventing percentages",async()=>{
  const calls:ConnectorRequest[]=[];
  const result=await collectMarketOverview({scope,...actor,connector:connector(request=>{calls.push(request);return request.operation==="market_research"?research({totalRevenue:null,avgRatings:"",top10ProductCrn:0.42,l6NewCount:0}):{code:"OK",data:{brands:12,sellers:9}};})});
  assert.equal(result.metrics.totalRevenue,null);assert.equal(result.metrics.avgRatings,null);
  assert.equal(result.metrics.newCount,0);assert.equal(result.metrics.productConcentrationRaw,0.42);
  assert.equal(result.metrics.brands,12);assert.equal(result.scope.month,"2026-08");
  assert.equal(result.issues.length,0);assert.equal(result.evidence.length,2);
  assert.ok(calls.every(x=>x.governorScope?.organizationId==="org-a"&&x.governorScope.jobId==="job-a"));
  assert.ok(calls.every(x=>(x.input.request as Record<string,unknown>).month==="202608"));
});
test("a single node resolves only an exact match, never the first search result",async()=>{
  const calls:string[]=[];
  await assert.rejects(()=>collectMarketOverview({scope:{...scope,nodeQuery:"456"},...actor,connector:connector(request=>{calls.push(request.operation);return {data:[{nodeIdPath:"123:999"}]};})}),/类目/);
  assert.deepEqual(calls,["product_node"]);
});
test("wrong category market rows are rejected even if first result has metrics",async()=>{
  await assert.rejects(()=>collectMarketOverview({scope,...actor,connector:connector(request=>request.operation==="market_research"?research({nodeId:"999",nodeIdPath:"123:999"}):{data:{}})}),/数据|类目/);
});
test("statistics failure preserves successful research evidence as partial",async()=>{
  const result=await collectMarketOverview({scope,...actor,connector:connector(request=>{
    if(request.operation==="market_research_statistics")throw new ConnectorError("sellerSprite","timeout",true);
    return research();
  })});
  assert.equal(result.metrics.totalUnits,1000);assert.equal(result.issues[0].code,"timeout");assert.equal(result.evidence.length,1);
});

test("unrecognized statistics produce a partial report instead of successful evidence",async()=>{
  const result=await collectMarketOverview({scope,...actor,connector:connector(request=>
    request.operation==="market_research"?research():{code:"OK",data:{unexpected:"payload-with-no-known-statistics"}}
  )});
  assert.equal(result.metrics.totalUnits,1000);
  assert.equal(result.issues[0].dataset,"statistics");
  assert.equal(result.issues[0].code,"malformed-response");
  assert.deepEqual(result.evidence.map(item=>item.dataset),["research"]);
});

test("statistics containing only a legitimate zero are usable",async()=>{
  const result=await collectMarketOverview({scope,...actor,connector:connector(request=>
    request.operation==="market_research"?research():{code:"OK",data:{newProducts:0}}
  )});
  assert.equal(result.metrics.newCount,0);
  assert.equal(result.issues.length,0);
  assert.equal(result.evidence.length,2);
});

test("a shared deadline preserves research completed before statistics timed out",async()=>{
  const result=await collectMarketOverview({scope,...actor,timeoutMs:25,connector:connector(async request=>{
    if(request.operation==="market_research")return research();
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(resolve,200);
      request.signal!.addEventListener("abort",()=>{clearTimeout(timer);reject(request.signal!.reason);},{once:true});
    });
    return {code:"OK",data:{brands:12}};
  })});
  assert.equal(result.metrics.totalUnits,1000);
  assert.equal(result.metrics.brands,null);
  assert.equal(result.issues[0].code,"timeout");
  assert.deepEqual(result.evidence.map(item=>item.dataset),["research"]);
});
test("empty sources fail, rather than producing a successful all-zero report",async()=>{
  await assert.rejects(()=>collectMarketOverview({scope,...actor,connector:connector(()=>({data:{}}))}),/数据|类目/);
});
test("conflicting statistics scope never contaminates the requested category",async()=>{
  const result=await collectMarketOverview({scope,...actor,connector:connector(request=>request.operation==="market_research"?research():{data:{nodeId:"999",brands:777}})});
  assert.equal(result.metrics.brands,null);assert.equal(result.issues[0].code,"scope-mismatch");
});
test("a cancelled collection does not return a successful report",async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>collectMarketOverview({scope,...actor,signal:controller.signal,connector:connector(()=>research())}));
});

test("multiple paths for the exact same node use the original first matching path",async()=>{
 const calls:ConnectorRequest[]=[];
 const result=await collectMarketOverview({scope:{...scope,nodeQuery:'456'},...actor,connector:connector(request=>{calls.push(request);
 return request.operation==='product_node'?{data:[{nodeIdPath:'123:999'},{nodeIdPath:'123:456'},{nodeIdPath:'987:456'}]}:request.operation==='market_research'?research():{data:{brands:12}};
 })});
 assert.equal(result.nodeIdPath,'123:456');
 assert.ok(calls.slice(1).every(r=>(r.input.request as any).nodeIdPath==='123:456'));
});

test("last30 omits the provider month instead of substituting the previous calendar month",async()=>{
 const calls:ConnectorRequest[]=[];
 const result=await collectMarketOverview({scope:{...scope,nodeQuery:'456',month:'last30'},...actor,connector:connector(request=>{calls.push(request);return request.operation==='product_node'?{data:[{nodeIdPath:'123:456'}]}:request.operation==='market_research'?research():{data:{brands:12}};})});
 assert.equal(result.scope.month,'last30');assert.equal(calls.length,3);
 assert.ok(calls.every(r=>!Object.hasOwn(r.input.request as object,'month')));
});
