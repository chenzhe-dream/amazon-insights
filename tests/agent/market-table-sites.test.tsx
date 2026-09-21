import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketShapeProductTable} from '../../app/market-shape-product-table';
import {MarketKeywordTable} from '../../app/market-keyword-table';
import {shapePageRun} from './helpers/market-shape-page-fixture';
import {keywordPageRun} from './helpers/market-keyword-page-fixture';

test('product links use the report marketplace domain',()=>{
 const run=shapePageRun().run;Object.assign(run.scope,{marketplace:'DE',currency:'EUR'});
 const html=renderToStaticMarkup(<MarketShapeProductTable run={run} selected={[]} assignments={{}} disabled={false} onSelected={()=>{}} onAssignment={()=>{}} bands="0,20,40"/>);
 assert.match(html,/https:\/\/www.amazon.de\/dp\/B000000001/);
 assert.doesNotMatch(html,/www.amazon.com\/dp/);
});
test('keyword table title uses its facts marketplace',()=>{
 const facts=keywordPageRun().run.facts!;Object.assign(facts.scope,{marketplace:'JP',currency:'JPY'});
 const html=renderToStaticMarkup(<MarketKeywordTable facts={facts} details={()=>null}/>);
 assert.match(html,/日本站.*类目关键词洞察/);assert.doesNotMatch(html,/美国站/);
});
