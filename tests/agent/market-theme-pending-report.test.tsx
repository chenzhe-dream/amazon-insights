import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketThemePendingReport} from '../../app/market-theme-section';
import {themeRun} from './helpers/market-theme-page-fixture';
function pending(status:'failed'|'queued'|'running'|'cancelled'){
 const run=themeRun().run;run.currentReport=null;run.latestSavedReport=null;run.history=[];run.status=status;run.steps[0]={...run.steps[0],kind:'collect-shape-pool',asin:null,status,errorCode:status==='failed'?'invalid-data':null,canRetry:false};return run;
}
test('failed anchor shows actual failed stage and recollection path, never claims background processing',()=>{
 const html=renderToStaticMarkup(<MarketThemePendingReport run={pending('failed')} runId="saved" node="1063294" readError={null}/>);
 assert.match(html,/主题分析失败/);assert.match(html,/取得Sorftime商品池/);assert.match(html,/返回数据未通过校验/);assert.match(html,/重新拉取/);assert.doesNotMatch(html,/后台正在处理|重试对应步骤/);
});
test('queued, running, cancelled and unread states remain distinguishable',()=>{
 for(const [status,label] of [['queued','等待后台执行'],['running','主题分析中'],['cancelled','分析已取消']] as const){
  const html=renderToStaticMarkup(<MarketThemePendingReport run={pending(status)} runId="saved" node="1063294" readError={null}/>);assert.match(html,new RegExp(label));assert.doesNotMatch(html,/0\/0/);
 }
 const html=renderToStaticMarkup(<MarketThemePendingReport run={pending('running')} runId="saved" node="1063294" readError="断开连接"/>);assert.match(html,/任务读取失败/);assert.doesNotMatch(html,/主题分析中/);
});
