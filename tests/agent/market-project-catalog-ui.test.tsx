import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {findHttpContract} from '../../shared/agent-contracts';
import {CategoryModuleCards,CategoryHistoryRows} from '../../app/market-project-catalog';

test('catalog and history are registered as static authenticated proxy routes',()=>{
 for(const suffix of ['catalog','history'])assert.equal(findHttpContract('GET','/v1/market-research/project-favorites/'+suffix)?.path,'/v1/market-research/project-favorites/'+suffix);
});
test('empty category still shows all four selectable module cards',()=>{
 const empty={reports:0,conditions:0,ready:0,running:0};
 const html=renderToStaticMarkup(<CategoryModuleCards category={{categoryId:'1063294',sites:['US'],reports:0,conditions:0,complete:false,updatedAt:'2026-10-14T00:00:00Z',modules:{overview:empty,shapes:empty,keywords:empty,themes:empty}}} selected="overview" onSelect={()=>{}}/>);
 for(const label of ['市场总览','商品形态及价格带','类目关键词洞察','类目买家评论见解'])assert.ok(html.includes(label));
 assert.equal((html.match(/<button/g)||[]).length,4);assert.ok(html.includes('暂无报告'));
});
test('history preview restores exact module scope and task without collection triggers; conditions have no report preview',()=>{
 const row={favoriteId:'fa3b0692-81ac-4771-ba53-4f43ce24de43',title:'灯具',creatorName:'Tester',updatedAt:'2026-10-14T00:00:00Z',status:'ready' as const,context:{shapes:{marketplace:'DE' as const,nodeIdPath:'1:987',fromMonth:'2026-06',toMonth:'2026-08',runId:'95cf0038-f904-4c70-9854-7f2c8112061a'}}};
 const html=renderToStaticMarkup(<CategoryHistoryRows items={[row,{...row,favoriteId:'95cf0038-f904-4c70-9854-7f2c8112061a',status:'conditions',context:{shapes:{...row.context.shapes,runId:undefined}}}]} module="shapes" onDetail={()=>{}}/>);
 assert.equal((html.match(/预览报告/g)||[]).length,1);assert.ok(html.includes('查看条件'));assert.ok(html.includes('marketShapeSite=DE'));assert.ok(html.includes('marketShapeNode=1%3A987'));assert.ok(html.includes('shapeRun=95cf0038'));assert.ok(!html.includes('linkedApply'));assert.ok(!html.includes('linkedBatch'));
});
