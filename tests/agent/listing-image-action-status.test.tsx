import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListingImageActions } from "../../app/listing-image-actions";
import type { SyncJob } from "../../app/lib/sync-server";
const asin="B0BXF8W8BM";
function job(status:string, stageStatus:string, detail?:string): SyncJob {
 return {jobId:"job-1", jobVersion:1,asins:[asin],marketplace:"US",status,message:"",currentStageId:"image_remarks",createdAt:"",updatedAt:"",asinProgress:{},stages:[{id:"image_remarks",label:"图片分析",kind:"auto",estimatedSeconds:0,status:stageStatus,imageAction:"analyze",repairAsins:[asin],detail}]};
}
function render(value:SyncJob,target=asin) {return renderToStaticMarkup(createElement(ListingImageActions,{asin:target,job:value,onAction:async()=>{}} as any));}
test("task status follows queued, running and completed snapshots",()=>{
 assert.match(render(job("queued","pending")),/排队中/);
 assert.match(render(job("running","running")),/分析中/);
 assert.match(render(job("completed","done")),/分析完成/);
});
test("a completed job with a partial image stage is not presented as full success",()=>{
 const value=job("completed","partial","图片 AI 备注：已完成 6/6 张 · 就绪 5 · 上游无结果 0 · 超时 0 · 连接失败 1");
 assert.match(render(value),/部分失败/);
 assert.match(render(value),/就绪 5/);
 assert.match(render(value),/连接失败 1/);
});
test("failed and publication-pending jobs have explicit statuses",()=>{
 assert.match(render(job("failed","failed")),/处理失败/);
 const value=job("completed","completed");
 value.publication={status:"pending",requestId:"r",artifactId:"a",requestedAt:""};
 assert.match(render(value),/正在更新页面/);
});
test("other ASINs and ordinary sync do not display this action status",()=>{
 assert.doesNotMatch(render(job("running","running"),"OTHER"),/role="status"/);
 const value=job("running","running"); delete value.stages[0].imageAction;
 assert.doesNotMatch(render(value),/role="status"/);
});
