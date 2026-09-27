import assert from 'node:assert/strict';
import test from 'node:test';
import {sortSectionRows} from '../../app/market-shape-reference/section-filter';
import type {ReferenceGroupRow} from '../../app/market-shape-reference/rules';

const row=(label:string,value:number|null):ReferenceGroupRow=>({label,linkCount:value??0,
 sales:{last3Months:value,last6Months:value,y2025:value,y2024:value},
 sharePct:{last3Months:value,last6Months:value,y2025:value,y2024:value},
 coverage:Object.fromEntries(['last3Months','last6Months','y2025','y2024'].map(p=>[p,{known:value===null?0:1,total:1,missing:value===null?1:0,notApplicable:0}])) as ReferenceGroupRow['coverage'],
 avgLast6MonthsMonthlyPerLink:value,avgY2025MonthlyPerLink:value,trendMissingLinkCount:0});
test('all original section metrics sort both ways, leave missing last, and never mutate rows',()=>{
 const rows=[row('C',null),row('B',30),row('A',10)],before=JSON.stringify(rows);
 for(const metric of ['last3Months','last6Months','y2025','y2024','last3MonthsSharePct','last6MonthsSharePct','y2025SharePct','y2024SharePct','avgLast6MonthsMonthlyPerLink','avgY2025MonthlyPerLink']){
  assert.deepEqual(sortSectionRows(rows,{metric,dir:'asc'} as never).map(r=>r.label),['A','B','C'],metric);
  assert.deepEqual(sortSectionRows(rows,{metric,dir:'desc'} as never).map(r=>r.label),['B','A','C'],metric);
 }
 assert.deepEqual(sortSectionRows(rows,{metric:'label',dir:'desc'} as never).map(r=>r.label),['C','B','A']);
 assert.equal(JSON.stringify(rows),before);
});
test('link count and default sort retain deterministic original ordering',()=>{
 const rows=[row('B',30),row('A',10),row('C',null)];
 assert.deepEqual(sortSectionRows(rows,{metric:'linkCount',dir:'asc'} as never).map(r=>r.label),['C','A','B']);
 assert.deepEqual(sortSectionRows(rows,null as never).map(r=>r.label),['B','A','C']);
});
