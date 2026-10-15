import test from 'node:test';
import assert from 'node:assert/strict';
import {keywordPageRun} from './helpers/market-keyword-page-fixture';
test('keyword queue and pool phases have no zero denominator; established trends retain real counts',async()=>{
 const module=await import('../../app/market-keyword-progress').catch(()=>null);
 assert.equal(typeof module?.keywordCollectionProgress,'function');
 const run=keywordPageRun().run;run.status='queued';run.steps=[];run.facts=null;
 assert.equal(module!.keywordCollectionProgress(run),'等待采集');
 run.status='running';assert.equal(module!.keywordCollectionProgress(run),'正在采集关键词并汇总词池');
 run.status='failed';assert.equal(module!.keywordCollectionProgress(run),'趋势任务尚未生成');
 run.steps=[{current:true,kind:'collect-keyword-trend',status:'succeeded'},{current:true,kind:'collect-keyword-trend',status:'empty'},{current:false,kind:'collect-keyword-trend',status:'failed'},{current:true,kind:'collect-keyword-trend',status:'queued'}] as typeof run.steps;
 assert.equal(module!.keywordCollectionProgress(run),'趋势已完成 2/3（其中 1 词研究月份无搜索量，其他月份历史仍保留）');
});
