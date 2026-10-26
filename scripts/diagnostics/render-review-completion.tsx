import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ReviewAnalysisMatrixSection} from '../../app/project-report-views/voc';
import {sorftimeReviewAnalysisMeta} from '../../app/seller-sprite-review-analysis';
import {readCachedArrayExport} from '../lib/sync-cache.mjs';

const directory=path.resolve(process.argv[2]);
const catalogFile=path.resolve(process.argv[3]);
const evidence=path.resolve(process.argv[4]);
const output=JSON.parse(fs.readFileSync(path.join(directory,'CA-stage-output.json'),'utf8'));
const asins=['B0H79SDS1R','B0C3Z8F66G','B0G7BK6ZF6','B0GY49HWVP','B0H7BLV7JS'];
const catalog=readCachedArrayExport(catalogFile,'refreshedCatalog');
const products=asins.map(asin=>{
  const product=catalog.find(row=>row.asin===asin);
  assert.ok(product, `Missing scoped catalog product ${asin}`);
  // Offline preview: no image proxy, provider request or other service dependency.
  return {...product,image:''};
});
const audit=JSON.parse(fs.readFileSync(path.join(directory,'audit.json'),'utf8')) as {
  results: {marketplace:string;ready:number;rows:{samples:number}[]}[];
};
const ca=audit.results.find(row=>row.marketplace==='CA');
assert.ok(ca);
assert.equal(ca.ready,2);
assert.equal(ca.rows.reduce((sum,row)=>sum+row.samples,0),3);
assert.equal(output.gap.items.length,3);
const css=['globals.css','warm-theme.css','comparison-layout.css','market-ui-reference.css'].map(file=>fs.readFileSync(path.resolve('app',file),'utf8').replace(/@import\s+[^;]+;/g,'')).join('\n');
const excerpts=products.map(product=>{
  const saved=JSON.parse(fs.readFileSync(path.join(evidence,`CA-${product.asin}-1.json`),'utf8'));
  assert.equal(saved.asin,product.asin);assert.equal(saved.site,'CA');
  return {product,items:(saved.payload.data.items??[]) as {title:string;star:number;content:string}[]};
});
const markup=renderToStaticMarkup(<html lang="zh-CN"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>加拿大评论补全 · 候选验收</title><style>{css}</style><style>{'body{padding:24px;font-family:"Microsoft YaHei",sans-serif}.review-acceptance{margin:0 auto 20px;max-width:1600px}.review-acceptance p{line-height:1.8}.ss-review-matrix-card{max-width:1600px;margin:auto}.source-review{margin:16px 0;padding:16px;background:#fff;border:1px solid #dbe4ee;border-radius:10px}.source-review p{font-size:13px}.acceptance-note{padding:16px 22px;background:#eef5ff;border:1px solid #d0dff5;border-radius:12px}'}</style></head><body>
  <header className="review-acceptance acceptance-note"><h2>加拿大站 · 评论补全候选验收</h2><p>5 个竞品中，2 个已有评论主题，共 3 条真实评论样本。另 3 个本次接口返回空，继续待补。样本很少，主题比例仅表示当前样本，不能代表全部买家。</p><p>这是已保存响应的只读回放，使用系统原有评论表格组件；尚未发布到 31900，也未进行完整任务写入验收。表头“已同步”表示商品资料，评论覆盖以各列样本数为准。</p></header>
  <ReviewAnalysisMatrixSection title="智能评论分析" description="按 ASIN 展示已取得的评论主题；缺失维度保留待补说明。" badge="Sorftime / 卖家精灵 MCP" data={output.data.analysisByAsin} dataMeta={{source:'已保存的卖家精灵 MCP review 响应',updatedAt:output.updatedAt}} configMeta={sorftimeReviewAnalysisMeta} pendingSteps={null} products={products} market="CA"/>
  <section className="review-acceptance"><h3>原始评论核对</h3><p>保留原文与星级供核对；未匹配主题的文字没有被替换成推测结论。</p>{excerpts.map(({product,items})=><details key={product.asin} className="source-review"><summary>{product.brand} · {product.asin} · {items.length} 条</summary>{items.length?items.map((review,index)=><article key={index}><h4>{review.title} · {review.star} 星</h4><p>{review.content}</p></article>):<p>本次保存响应没有评论样本，需补充本站点、同 ASIN 的真实评论后重新分析。</p>}</details>)}</section>
  </body></html>);
assert.ok(markup.includes('儿童使用'));
assert.ok(markup.includes('学习间隙休息'));
assert.ok(markup.includes('室内使用'));
assert.ok(markup.includes('评论样本：2'));
assert.ok(markup.includes('本次接口返回 0 条评论样本，待补充'));
fs.writeFileSync(path.join(directory,'ca-review-acceptance.html'),'<!doctype html>'+markup);
console.log(JSON.stringify({file:path.join(directory,'ca-review-acceptance.html'),renderedAsins:5,samples:3,themeReadyAsins:2,missingAsins:3}));
