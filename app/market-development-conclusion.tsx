'use client';
import React,{useEffect,useState} from 'react';
import {ConclusionBasisSchema,ConclusionResponseSchema,type ConclusionBasis,type ConclusionResponse} from '../shared/market-development-conclusion';
import {localAgentFetch,localAgentErrorMessage} from './lib/local-agent-browser';
import {LaunchSection} from './launch-section';
const labels={overview:'市场总览',shapes:'形态价格带',keywords:'关键词',themes:'评论'};
export async function readDevelopmentConclusion(basis:ConclusionBasis,signal:AbortSignal,snapshot?:string){
 const params=new URLSearchParams({basis:JSON.stringify(ConclusionBasisSchema.parse(basis)),...(snapshot?{snapshot}:{})});
 const response=await localAgentFetch(`/v1/market-analysis/conclusions?${params}`,{signal,cache:'no-store'}),value=await response.json();signal.throwIfAborted();
 if(!response.ok)throw new Error(localAgentErrorMessage(value,'结论读取失败，已有报告保留'));
 const result=ConclusionResponseSchema.parse(value);if(JSON.stringify(result.basis)!==JSON.stringify(ConclusionBasisSchema.parse(basis))||snapshot&&result.contentHash!==snapshot)throw new Error('结论版本与请求不一致');return result;
}
export function MarketDevelopmentConclusion({basis,writesDisabled=false}:{basis:ConclusionBasis;writesDisabled?:boolean}){
 const identity=JSON.stringify(basis);
 return <DevelopmentConclusion key={identity} basis={basis} writesDisabled={writesDisabled}/>;
}
function DevelopmentConclusion({basis,writesDisabled}:{basis:ConclusionBasis;writesDisabled:boolean}){
 const [value,setValue]=useState<ConclusionResponse|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[snapshot,setSnapshot]=useState('');
 useEffect(()=>{const abort=new AbortController();setBusy(true);setError(null);void readDevelopmentConclusion(basis,abort.signal,snapshot||undefined).then(setValue).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'结论读取失败');}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});return()=>abort.abort();},[basis.kind==='linked'?basis.batchId:basis.runId,basis.kind==='reviews'?basis.attemptId:'',basis.kind==='reviews'?basis.revisionId:'',reload,snapshot]);
 const [saving,setSaving]=useState(false);
 async function save(){if(!value||saving||busy||writesDisabled)return;setSaving(true);setError(null);try{
  const response=await localAgentFetch('/v1/market-analysis/conclusions',{method:'POST',body:JSON.stringify({basis,expectedHash:value.contentHash})}),body=await response.json();
  if(!response.ok)throw new Error(localAgentErrorMessage(body,'保存失败；若报告已变化，请先重读结论'));
  const saved=ConclusionResponseSchema.parse(body);if(saved.contentHash!==value.contentHash)throw new Error('保存版本不一致');setValue(saved);setSnapshot(saved.contentHash);
 }catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setSaving(false);}}
 const report=value?.conclusion,retained=!!error&&!!value;
 return <LaunchSection title={basis.kind==='reviews'?'类目买家评论 · 最终开品结论':'四模块 · 综合开发结论'} description={basis.kind==='linked'?'依据此联动批次各模块的最新保存版本；上方单独切换历史报告不会改写本结论。保存可冻结当前依据。':'根据当前评论报告与所选样本版本自动生成；保存可冻结当前结论与依据。'} badge={<span className="source-badge">{snapshot?'冻结历史版本':'当前保存数据的规则分析'}</span>}>
  <div className="category-cs-actions" style={{marginBottom:12,flexWrap:"wrap"}}><button type="button" disabled={busy||saving} onClick={()=>{setSnapshot('');setReload(n=>n+1);}}>重读已有报告结论</button><button type="button" disabled={!value||busy||saving||writesDisabled||!!snapshot||!!error||report?.status==='no-data'} onClick={()=>void save()}>{saving?'正在保存…':'保存当前结论'}</button>
   {!!value?.history.length&&<label style={{fontSize:12,color:"#62758e"}}>结论版本 <select style={{border:"1px solid #cad6e6",borderRadius:6,padding:6,background:"white"}} aria-label="结论版本" disabled={busy||saving} value={snapshot} onChange={e=>setSnapshot(e.target.value)}><option value="">当前分析</option>{value.history.map(h=><option key={h.contentHash} value={h.contentHash}>{new Date(h.savedAt).toLocaleString('zh-CN')} · {h.contentHash.slice(0,8)}</option>)}</select></label>}
  </div>
  {error&&<p role="alert" className="market-research-error">{error}{retained?'；下方保留上次读取的结论，未当作新结果。':''}</p>}
  {busy&&<p role="status">正在读取已保存证据…</p>}
  {report&&<>
   <p className="market-research-note">{report.scope.marketplace} · 类目 {report.scope.nodeIdPath} · {report.scope.fromMonth} 至 {report.scope.toMonth} · {report.version}{value.savedAt?` · 保存于 ${new Date(value.savedAt).toLocaleString('zh-CN')}`:''}</p>
   <h4>{report.headline}</h4>
   {report.sections.map((s,i)=><article className="listing-age-conclusion" style={{fontSize:13,lineHeight:1.7}} key={i}><h5>{s.title.replace(/ · (已知依据|分析与候选)$/, "")} · {s.status==='observed'?'已知事实':s.status==='candidate'?'分析与候选':'待验证'}</h5><p style={{whiteSpace:'pre-line'}}>{s.text}</p></article>)}
   <h4>开发优先级与下一步</h4><ul>{report.actions.map((a,i)=><li key={i}><strong>{a.priority} · {a.action}</strong><p>{a.validation}</p></li>)}</ul>
   <details open={report.status==='no-data'}><summary>数据缺口与判断边界（{report.gaps.length}）</summary><ul>{report.gaps.map((g,i)=><li key={i}>{g}</li>)}</ul></details>
   <details><summary>报告与证据版本</summary>{report.evidence.map(e=><div key={e.module}><p>{labels[e.module]} · {e.status==='ready'?'有可用依据':e.status==='partial'?'部分依据':e.status==='mismatch'?'范围不一致，已排除':'尚无有效报告'} · {e.identity??'暂无版本'}</p>{e.runId&&<a href={`/?tab=market-overview&themeView=${e.module}&${{overview:'overviewRun',shapes:'shapeRun',keywords:'keywordRun',themes:'themeRun'}[e.module]}=${e.runId}`} target="_blank" rel="noreferrer">打开来源模块</a>}<p style={{overflowWrap:'anywhere'}}>{e.refs.join('；')}</p></div>)}</details>
  </>}
 </LaunchSection>;
}
