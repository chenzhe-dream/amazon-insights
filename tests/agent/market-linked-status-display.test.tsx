import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketLinkedStatus} from '../../app/market-linked-status';
import type {MarketLinkedBatch} from '../../shared/market-linked-contracts';
const batch={id:'10000000-0000-4000-8000-000000000001',request:{scope:{marketplace:'US',nodeQuery:'3024183011',month:'2026-09',headTopN:10,newProductMonths:6},fromMonth:'2026-09'},basicJobId:'20000000-0000-4000-8000-000000000001',basicRetryable:true,status:'pending',message:'正在等待卖家精灵基础数据',categoryName:null,resolvedNodeIdPath:null,modules:{overview:{status:'pending',runId:null,message:null},shapes:{status:'started',runId:'30000000-0000-4000-8000-000000000001',message:null},keywords:{status:'pending',runId:null,message:'等待类目名称'},themes:{status:'started',runId:'40000000-0000-4000-8000-000000000001',message:null}}} as MarketLinkedBatch;
test('submission and pending stages are visible without pretending started reports are complete',()=>{
 const submitting=renderToStaticMarkup(<MarketLinkedStatus batch={null} error={null} busy onRetry={()=>{}}/>);assert.match(submitting,/正在提交/);
 const html=renderToStaticMarkup(<MarketLinkedStatus batch={batch} error={null} busy={false} onRetry={()=>{}}/>);assert.match(html,/正在等待卖家精灵/);assert.match(html,/已启动/);assert.match(html,/等待类目名称/);assert.doesNotMatch(html,/分析已完成/);
});
test('base retry remains available when other modules have already started',()=>{
 const html=renderToStaticMarkup(<MarketLinkedStatus batch={{...batch,status:'failed'}} error={null} busy={false} onRetry={()=>{}}/>);assert.match(html,/重试基础采集/);
});
