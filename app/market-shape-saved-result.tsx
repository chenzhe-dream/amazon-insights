'use client';
import React, {useEffect, useState} from 'react';
import type {MarketShapeRun} from '../shared/market-shape-public-contracts';
import {CURRENT_SHAPE_CALCULATION_VERSION} from '../shared/market-shape-calculation-version';
import {readShapeReferenceRevision} from './lib/market-shape-browser';
import {toShapeReferenceReport} from './lib/market-shape-reference-adapter';
import {MarketShapeReferenceView} from './market-shape-reference/view';
import {MarketShapeReport} from './market-shape-report';

/** Historical preview has no draft editor, autosave, retry or collection callbacks. */
export function MarketShapeSavedResult({run}: {run: MarketShapeRun}) {
  const [revision, setRevision] = useState<Awaited<ReturnType<typeof readShapeReferenceRevision>> | null>(null);
  useEffect(() => {
    if (!run.referenceRevision) return;
    const abort = new AbortController();
    void readShapeReferenceRevision(run.id, run.referenceRevision.revisionId, abort.signal).then(value => { if (!abort.signal.aborted) setRevision(value); }).catch(() => { /* The saved source remains viewable. */ });
    return () => abort.abort();
  }, [run.id, run.referenceRevision?.revisionId]);
  const source = run.source;
  const data = revision?.data ?? (source?.sorftimePool && source.productHistory && source.productAmountHistory && run.categoryDashboard ? {
    calculationVersion: CURRENT_SHAPE_CALCULATION_VERSION, scope: run.scope, pool: source.sorftimePool,
    productImages: source.productImages, productHistory: source.productHistory, productAmountHistory: source.productAmountHistory, categoryDashboard: run.categoryDashboard,
  } : null);
  if (data) return <MarketShapeReferenceView report={toShapeReferenceReport(data)} assignments={Object.fromEntries((revision?.assignments ?? []).filter(item=>item.label!==null).map(item=>[item.asin,item.label!]))} selectedAsins={revision?.selectedAsins ?? data.pool.products.map(product => product.asin)} disabled poolSizeDisabled onAssignment={() => {}} onSelected={() => {}}/>;
  if (run.latestRevision) return <MarketShapeReport report={run.latestRevision}/>;
  return <section className="card"><p>上次商品来源：{source?.fetchedAt}，共 {source?.products.length ?? 0} 件</p><table><thead><tr><th>ASIN</th><th>商品</th><th>价格</th><th>销量</th></tr></thead><tbody>{source?.products.map(product => <tr key={product.asin}><td>{product.asin}</td><td>{product.title}</td><td>{product.price ?? '未知'}</td><td>{product.units ?? '未知'}</td></tr>)}</tbody></table></section>;
}
