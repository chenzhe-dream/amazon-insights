"use client";
import React,{useEffect,useState} from 'react';
import {z} from 'zod';
import {MarketThemeEvidenceSchema} from '../shared/market-theme-evidence-contracts';
import {readThemeEvidence} from './lib/market-theme-browser';
type Evidence=z.infer<typeof MarketThemeEvidenceSchema>;
export function ThemeEvidenceContent({value,semanticSkipped=false}:{value:Evidence;semanticSkipped?:boolean}) {
  const analysis=value.analysis;
  return <div className="market-theme-full-evidence">
    <p className="market-research-note">以下为此报告保存的 Customers Say 摘要原文，不是逐条评论。</p>
    <h4>原主题名称</h4><p className="market-theme-evidence">{value.keyword}</p>
    <h4>完整摘要原文</h4><p className="market-theme-evidence">{value.content||'原文为空'}</p>
    {semanticSkipped?<p>此任务未启用语义归组，原主题与摘要仍保留。</p>:<><h4>已保存的模型分析</h4>{!analysis?<p>此版本没有可用的模型结果，原文仍保留。</p>:<>
      {analysis.status==='mapped'?<><p>主题中文名称：{analysis.labelZh}</p><p>归类解释：{analysis.explanationZh}</p></>:<p>尚未归类 · {analysis.reason}</p>}
      {analysis.evidence.length===0?<p>此模型结果未提供原文引用。</p>:<ol>{analysis.evidence.map((ref,index)=><li key={index}><blockquote>{ref.quote}</blockquote><small>{ref.field==='keyword'?'主题名称':'摘要正文'} · 字符位置 {ref.start}–{ref.end}（左闭右开）</small></li>)}</ol>}
      <details><summary>模型审计身份</summary><p>模型任务：{analysis.agentRunId}<br/>批次：{analysis.batchId}<br/>输出摘要：{analysis.outputDigest}</p></details>
    </>}</>}
  </div>;
}
export function MarketThemeEvidence({runId,attemptId,reportHash,sourceThemeId,semanticSkipped=false}:{runId:string;attemptId:string;reportHash:string;sourceThemeId:string;semanticSkipped?:boolean}) {
  const [open,setOpen]=useState(false),[value,setValue]=useState<Evidence|null>(null),[error,setError]=useState<string|null>(null),[revision,setRevision]=useState(0);
  useEffect(()=>{if(!open)return;const owner=new AbortController();setValue(null);setError(null);
    void readThemeEvidence(runId,attemptId,reportHash,sourceThemeId,owner.signal).then(result=>{if(!owner.signal.aborted)setValue(result);}).catch(e=>{if(!owner.signal.aborted)setError(e instanceof Error?e.message:'证据读取失败');});return()=>owner.abort();
  },[open,runId,attemptId,reportHash,sourceThemeId,revision]);
  return <section aria-label="完整主题证据"><button type="button" className="ghost-btn" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{open?'收起完整证据':semanticSkipped?'查看完整摘要与来源':'查看完整原文与模型解释'}</button>
    {open&&(error?<p role="alert" className="market-research-error">{error} <button type="button" className="ghost-btn" onClick={()=>setRevision(v=>v+1)}>重读证据</button></p>:value?<ThemeEvidenceContent value={value} semanticSkipped={semanticSkipped}/>:<p role="status">正在读取已保存证据…</p>)}
  </section>;
}
