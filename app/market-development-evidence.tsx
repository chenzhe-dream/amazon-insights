'use client';
import React from 'react';
import type {DevelopmentDecision} from '../shared/market-development-association';

const statusLabels={supported:'可进入方案验证',hold:'先核实反证或风险','needs-evidence':'待补关联证据'};
const moduleLabels:Record<string,string>={overview:'市场背景',shapes:'对应商品',keywords:'需求依据',themes:'同商品评论'};
export function MarketDevelopmentEvidence({decision:d}:{decision:DevelopmentDecision}){
 return <section aria-label="跨模块关联分析" style={{fontSize:13,lineHeight:1.75}}>
  <p>{d.coverage}</p>
  <h4>市场背景与候选方向</h4>
  {d.marketContext.length?<ul>{d.marketContext.map((m,i)=><li key={i}>{m.description}</li>)}</ul>:<p>尚无可核对的市场背景指标；以下方向仅依据已取得的需求、商品与评论。</p>}
  {d.candidates.length===0&&<p>暂无具备关联条件的需求标签，模块已有结果仍在下方保留。</p>}
  {d.candidates.map(c=><article key={c.id} className="listing-age-conclusion" style={{borderLeft:`3px solid ${c.status==='hold'?'#dc8542':c.status==='supported'?'#39a18c':'#a4b2c7'}`,padding:16,marginBottom:12}}>
   <h5 style={{fontSize:14,marginTop:0}}>{c.label} · {statusLabels[c.status]}</h5>
   <p>{c.reason}</p>
   <p><strong>对应商品：</strong>{c.asins.join('、')||'暂无已确认关联的商品属性'}</p>
   <p><strong>样本参考价格：</strong>{c.price}。不作为建议售价或利润。</p>
   <details><summary>关联依据（{c.evidence.length}）</summary><ul>{c.evidence.map((e,i)=><li key={i}><strong>{moduleLabels[e.module]??e.module}：</strong>{e.description}<div style={{color:'#62758e',overflowWrap:'anywhere'}}>来源：{e.ref}</div></li>)}</ul></details>
   {!!c.counterevidence.length&&<div><strong>相反信号与风险线索</strong><ul>{c.counterevidence.map((v,i)=><li key={i}>{v}</li>)}</ul></div>}
   <details><summary>此方向仍缺少的证据（{c.missing.length}）</summary><ul>{c.missing.map((v,i)=><li key={i}>{v}</li>)}</ul></details>
   <p><strong>验证行动：</strong>{c.next}</p>
  </article>)}
  {!!d.conflicts.length&&<article className="listing-age-conclusion"><h4>口径差异与数据冲突</h4><ul>{d.conflicts.map((c,i)=><li key={i}><strong>{c.kind==='conflict'?'同口径冲突':'不可直接比较'}：</strong>{c.message}<details><summary>核对来源</summary>{c.refs.join('；')}</details></li>)}</ul></article>}
  {!!d.risks.length&&<article className="listing-age-conclusion"><h4>需优先人工核实的风险片段</h4><ul>{d.risks.map((r,i)=><li key={i}>{r.asin}：{r.text}<p>{r.reason}</p><small>来源：{r.ref}</small></li>)}</ul></article>}
  {!!d.reconciliations.length&&<details><summary>跨模块已补充的依据</summary><ul>{d.reconciliations.map((r,i)=><li key={i}>{r}</li>)}</ul></details>}
  <details><summary>本次关联规则与适用边界</summary>{d.rules.map(r=><p key={r.id}><strong>{r.id} · v{r.version}</strong>：{r.condition}<br/>{r.limitation}</p>)}</details>
 </section>;
}
