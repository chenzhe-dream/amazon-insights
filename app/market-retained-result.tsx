'use client';
import React, {useEffect, useRef, useState, type ReactNode} from 'react';
import {loadPreviousMarketResult, needsPreviousMarketResult, previousMarketRun, rememberPreviousMarketRun, sameRetainedConditions, type MarketRunKey, type RetainableMarketRun} from './lib/market-retained-result';

export function MarketRetainedResult<T extends RetainableMarketRun>({current, runKey, read, usable, children}: {
  current: T | null; runKey: MarketRunKey; read: (id: string, signal: AbortSignal) => Promise<T>; usable: (run: T) => boolean; children: (run: T) => ReactNode;
}) {
  const [loaded, setLoaded] = useState<{forId: string; run: T | null; error: string | null} | null>(null);
  const callbacks = useRef({read, usable, current}); callbacks.current = {read, usable, current};
  const last = useRef<string | null>(null);
  const id = current?.id, needsPrevious = !!current && needsPreviousMarketResult(current, usable);
  useEffect(() => {
    if (!id) { last.current = null; return; }
    rememberPreviousMarketRun(runKey, id, last.current); last.current = id;
    if (!needsPrevious) return;
    const abort = new AbortController(), snapshot = callbacks.current;
    void loadPreviousMarketResult(snapshot.current!, snapshot.read, value => previousMarketRun(runKey, value), snapshot.usable, abort.signal)
      .then(run => { if (!abort.signal.aborted) setLoaded({forId: id, run, error: null}); })
      .catch(() => { if (!abort.signal.aborted) setLoaded({forId: id, run: null, error: '上次报告读取失败，请检查登录状态或访问权限；本次任务状态仍单独展示。'}); });
    return () => abort.abort();
  }, [id, needsPrevious, runKey]);
  if (!current || !needsPrevious || !loaded || loaded.forId !== id) return null;
  if (loaded.error) return <p role="alert" className="market-research-notice">{loaded.error}</p>;
  const saved = loaded.run;
  if (!saved || !sameRetainedConditions(current, saved)) return null;
  const quota = current.steps.some(step => step.current && step.errorCode === 'quota-exhausted');
  const failed = current.status === 'failed' || current.steps.some(step => step.current && ['failed', 'interrupted'].includes(step.status));
  return <section aria-label="保留的上次报告">
    <p role="status" className="market-research-notice">{quota ? '数据源额度已耗尽，本次刷新未完成。' : failed ? '本次分析有失败步骤，刷新未完成。' : '本次分析尚无可用新结果。'}以下保留同条件的上次报告，仅供查看，不代表本次结果。<br/>当前任务：{current.id}；历史报告任务：{saved.id}。数据时间以原报告为准。</p>
    {children(saved)}
  </section>;
}
