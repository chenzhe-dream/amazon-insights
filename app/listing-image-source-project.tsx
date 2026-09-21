"use client";

import {useEffect,useRef,useState} from 'react';
import type {AnalysisProject} from './project-library-panel';
import {LocalDataProjectResponseSchema,LocalDataProjectsResponseSchema} from '../shared/agent-contracts';
import {localAgentFetch} from './lib/local-agent-browser';
import {eligibleImageSourceProjects} from './lib/image-source-project';

export function ListingImageSourceProject({projectId,asins,marketplace,onContext,onOpen}:{
 projectId:string|null;asins:string[];marketplace:string;
 onContext:(context:{projectId:string;kind:string})=>void;
 onOpen:(project:AnalysisProject)=>void;
}){
 const [project,setProject]=useState<AnalysisProject|null>(null),[choices,setChoices]=useState<AnalysisProject[]>([]);
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[reload,setReload]=useState(0);
 const inFlight=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const asinKey=asins.join(',');
 useEffect(()=>{
  const abort=new AbortController();let current=true;
  setProject(null);setChoices([]);setError('');setLoading(true);
  async function json(path:string){const response=await localAgentFetch(path,{signal:abort.signal});if(!response.ok)throw Error(`读取项目失败（${response.status}），请重试`);return response.json();}
  async function load(){
   if(!projectId)return;
   const {project:p}=LocalDataProjectResponseSchema.parse(await json(`/v1/local-data/projects/${encodeURIComponent(projectId)}`));
   if(!current)return;
   if(p.id!==projectId||p.marketplace!==marketplace||asinKey.split(',').some(asin=>!p.asins.includes(asin)))throw Error('当前页面与项目范围不匹配，请重新打开项目');
   setProject(p);onContext({projectId:p.id,kind:p.kind});
   if(p.kind==='analysis')return;
   const [local,registered]=await Promise.all([json('/v1/local-data/projects?kind=analysis'),json('/v1/projects')]);
   if(!current)return;
   if(!Array.isArray(registered.projects))throw Error('来源项目返回格式异常');
   setChoices(eligibleImageSourceProjects(p,LocalDataProjectsResponseSchema.parse(local).projects,registered.projects));
  }
  void load().catch(e=>{if(current)setError(e instanceof Error?e.message:'读取来源项目失败')}).finally(()=>{if(current)setLoading(false)});
  return()=>{current=false;abort.abort()};
 },[projectId,marketplace,asinKey,onContext,reload]);
 async function open(source:AnalysisProject){
  if(!project||inFlight.current)return;
  inFlight.current=true;setSaving(true);setError('');
  try{
   if(!project.sourceProjectId){
    const response=await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(project.id)}`,{method:'PATCH',body:JSON.stringify({sourceProjectId:source.id})});
    if(!response.ok)throw Error(`关联来源项目失败（${response.status}），请重试`);
    const payload=LocalDataProjectResponseSchema.parse(await response.json());
    if(payload.project.id!==project.id||payload.project.sourceProjectId!==source.id)throw Error('来源关联返回不匹配，请刷新重试');
    if(alive.current)setProject(payload.project);
   }
   if(alive.current)onOpen(source);
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'打开来源失败')}
  finally{inFlight.current=false;if(alive.current)setSaving(false)}
 }
 if(!projectId)return null;
 if(project?.kind==='analysis'&&!error)return null;
 return <section className="card" aria-label="图片来源项目">
  <strong>{loading?'正在读取图片处理项目…':'在来源分析项目中处理图片'}</strong>
  {!loading&&project?.kind!=='analysis'&&<p>当前是收藏视图。已有图片可以查看；重新抓取或分析需要进入原始分析项目。</p>}
  {!loading&&!error&&choices.length===0&&<p>{project?.sourceProjectId?'来源项目不可访问、未同步或商品范围已变化，请联系管理员核对。':'尚未找到可关联的已同步分析项目，请从历史项目核对原始商品组合。'}</p>}
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{choices.map(source=><button className="ghost-btn" type="button" key={source.id} disabled={saving} onClick={()=>void open(source)}>{project?.sourceProjectId?'打开来源':'关联并打开'}：{source.name}</button>)}</div>
  {error&&<div role="alert">{error} <button className="ghost-btn" type="button" disabled={saving} onClick={()=>setReload(v=>v+1)}>重新读取</button></div>}
 </section>;
}
