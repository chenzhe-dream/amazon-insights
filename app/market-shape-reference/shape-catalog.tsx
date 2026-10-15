"use client";
import {useState} from 'react';
export const SCOOTER_SHAPES=['三轮滑板车','小两轮滑板车','大两轮滑板车'];
export function fixedShapeLabels(categoryName:string,nodeId:string,marketplace='US'){return marketplace==='US'&&nodeId.split(':').at(-1)==='13280971'&&!/mobility|electric|代步|电动/i.test(categoryName)?SCOOTER_SHAPES:[];}

export function ShapeCatalog({labels,fixed,assignments,onAssignment,onLabels,disabled}:{labels:string[];fixed:string[];assignments:Record<string,string>;onAssignment:(asin:string,label:string)=>void;onLabels:(labels:string[])=>void;disabled:boolean}){
 const [name,setName]=useState(''),[target,setTarget]=useState(''),[deleting,setDeleting]=useState<string|null>(null),[error,setError]=useState('');
 const affected=(label:string)=>Object.values(assignments).filter(value=>value.trim()===label).length;
 function change(){const next=name.trim();if(!next||next.length>60)return; if(fixed.length){setError('此类目使用固定形态目录。');return;}setError('');if(target){for(const[asin,label]of Object.entries(assignments))if(label.trim()===target)onAssignment(asin,next);}onLabels([...new Set([...labels.filter(label=>label!==target),next])]);setName('');setTarget('');}
 return <details className="shape-catalog"><summary>管理形态名称</summary><p className="market-research-note">{fixed.length?'此类目使用三种固定形态，不能删除；旧标签保留并等待人工确认。':'可新增、重命名或删除自定义形态；修改后草稿即时统计。'}</p>
 <div className="market-theme-actions"><select aria-label="管理形态" value={target} onChange={e=>{setTarget(e.target.value);setName(e.target.value);setDeleting(null)}} disabled={disabled}><option value="">新增名称</option>{labels.map(label=><option key={label}>{label}</option>)}</select><input aria-label="形态名称" placeholder="输入形态名称" value={name} onChange={e=>setName(e.target.value)} maxLength={60} disabled={disabled||!!fixed.length}/><button className="ghost-btn" type="button" disabled={disabled||!!fixed.length||!name.trim()} onClick={change}>{target?'重命名':'新增形态'}</button><button className="ghost-btn danger" type="button" disabled={disabled||!!fixed.length||!target} onClick={()=>setDeleting(target)}>删除形态</button></div>
 {deleting&&<div role="alert">删除“{deleting}”将把 {affected(deleting)} 件商品恢复为未分类。<button type="button" className="ghost-btn danger" disabled={disabled} onClick={()=>{for(const[asin,label]of Object.entries(assignments))if(label.trim()===deleting)onAssignment(asin,'');onLabels(labels.filter(label=>label!==deleting));setDeleting(null);setTarget('');setName('');}}>确认删除形态</button><button type="button" className="ghost-btn" onClick={()=>setDeleting(null)}>取消</button></div>}{error&&<p role="alert">{error}</p>}
 </details>;
}
