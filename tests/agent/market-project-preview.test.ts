import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProjectPreviewContext} from '../../shared/market-project-preview';
import type {ProjectContext} from '../../shared/market-project-favorites-contracts';

const scope={marketplace:'US' as const,nodeIdPath:'1:456',fromMonth:'2026-07',toMonth:'2026-09'};
const id=(n:number)=>`80000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context:ProjectContext={overview:{...scope,runId:id(1)},headTopN:'10',newProductMonths:'6'};
const candidate=(module:'shapes'|'keywords'|'themes',n:number,change:object={})=>({context:{[module]:{...scope,runId:id(n),...change}},status:'ready' as const,createdAt:`2026-10-${String(n).padStart(2,'0')}T00:00:00Z`});

test('preview binds saved peers by category/site/end period, keeps selected version and actual ranges',()=>{
 const result=buildProjectPreviewContext(context,'overview',[
  candidate('shapes',2,{nodeIdPath:'456',fromMonth:'2026-09'}),candidate('keywords',3),
  candidate('themes',4,{nodeIdPath:'999'}),candidate('themes',5,{marketplace:'DE'}),
  candidate('themes',6,{toMonth:'2026-08'}),candidate('themes',7,{overviewPeriod:'last30'}),
 ]);
 assert.deepEqual(result.overview,context.overview);
 assert.equal(result.shapes?.runId,id(2));assert.equal(result.shapes?.fromMonth,'2026-09');
 assert.equal(result.keywords?.runId,id(3));assert.equal(result.themes?.runId,undefined);
 assert.equal(result.themes?.nodeIdPath,'1:456');assert.equal(result.themes?.marketplace,'US');
});

test('exact range wins then usable report status and stable report creation time, never favorite edit time',()=>{
 const latestPartial={...candidate('shapes',9),status:'partial' as const};
 const result=buildProjectPreviewContext(context,'overview',[candidate('shapes',8,{fromMonth:'2026-09'}),latestPartial,candidate('shapes',2),candidate('shapes',3)]);
 assert.equal(result.shapes?.runId,id(3));
 const unavailable={...candidate('themes',9),status:'unavailable' as const};
 assert.equal(buildProjectPreviewContext(context,'overview',[unavailable]).themes?.runId,undefined);
});

test('preview from any module resets unrelated scopes and uses peer overview parameters',()=>{
 const source:ProjectContext={...context,shapes:{...scope,runId:id(2)},themes:{...scope,nodeIdPath:'999',runId:id(9)}};
 const result=buildProjectPreviewContext(source,'shapes',[{context:{overview:{...scope,runId:id(3)},headTopN:'20',newProductMonths:'3'},status:'ready',createdAt:'2026-10-10T00:00:00Z'}]);
 assert.equal(result.shapes?.runId,id(2));assert.equal(result.overview?.runId,id(3));assert.equal(result.headTopN,'20');
 assert.equal(result.themes?.nodeIdPath,scope.nodeIdPath);assert.equal(result.themes?.runId,undefined);
});
