"use client";
import {useEffect,useRef,useState} from 'react';
import {ALL_MODULES,MODULES,ModuleVisibilityDefaultsSchema,type ModuleVisibilityDefaults,type ModuleKey} from '../../../shared/module-visibility-contracts';
import {localAgentFetch} from '../../lib/local-agent-browser';
import {useModalInteraction} from '../../lib/use-modal-interaction';
import styles from './module-visibility-panel.module.css';

export function NewUserModuleDefaults({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}){
 const [policy,setPolicy]=useState<ModuleVisibilityDefaults|null>(null),[selected,setSelected]=useState<ModuleKey[]>([]);
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0),[conflict,setConflict]=useState(false);
 const dialog=useRef<HTMLDivElement>(null),alive=useRef(true),savingRef=useRef(false);
 useModalInteraction(true,dialog);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{
  const controller=new AbortController();let current=true;
  void localAgentFetch('/v1/admin/module-visibility/defaults',{signal:controller.signal})
   .then(async response=>{if(!response.ok)throw new Error(response.status===403?'无权设置新用户默认模块。':'读取默认设置失败，请重试。');return ModuleVisibilityDefaultsSchema.parse(await response.json())})
   .then(value=>{if(current){setPolicy(value);setSelected(value.visibleModules)}})
   .catch(reason=>{if(current)setError(reason instanceof Error?reason.message:'读取默认设置失败。')})
   .finally(()=>{if(current)setLoading(false)});
  return()=>{current=false;controller.abort()};
 },[revision]);
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!savingRef.current)onClose()};
  window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 },[onClose]);
 const close=()=>{if(!savingRef.current)onClose()};
 const reload=()=>{setLoading(true);setPolicy(null);setError('');setConflict(false);setRevision(value=>value+1)};
 const save=async()=>{
  if(!policy||loading||savingRef.current||conflict)return;
  savingRef.current=true;setSaving(true);setError('');
  try{
   const response=await localAgentFetch('/v1/admin/module-visibility/defaults',{method:'PUT',body:JSON.stringify({visibleModules:ALL_MODULES.filter(key=>selected.includes(key)),version:policy.version})});
   if(!response.ok){
    if(response.status===409){if(alive.current)setConflict(true);throw new Error('默认配置已被其他管理员更新，请重新读取后再修改。')}
    throw new Error(response.status===401?'登录已失效，请重新登录。':response.status===403?'无权设置新用户默认模块。':'保存默认设置失败，请重试。');
   }
   ModuleVisibilityDefaultsSchema.parse(await response.json());
   if(alive.current)onSaved();
  }catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'保存默认设置失败。')}
  finally{savingRef.current=false;if(alive.current)setSaving(false)}
 };
 const disabled=loading||saving||!policy||conflict;
 return <div className={styles.backdrop} onMouseDown={event=>{if(event.target===event.currentTarget)close()}}>
  <div ref={dialog} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="default-visibility-title" tabIndex={-1}>
   <header><div><h2 id="default-visibility-title">新用户默认模块</h2><p>设置钉钉新用户首次进入时可见的模块</p></div><button aria-label="关闭默认配置" disabled={saving} onClick={close}>×</button></header>
   <p className={styles.note}>仅对保存后首次登录并创建的钉钉账号生效。现有用户和本地账号保持当前配置，钉钉人员可再单独调整。</p>
   {loading?<p role="status" className={styles.note}>正在读取默认设置…</p>:policy&&<>
    <div className={styles.bulk}><span>已选择 {selected.length} / {MODULES.length}</span><button disabled={disabled} onClick={()=>setSelected([...ALL_MODULES])}>全选</button><button disabled={disabled} onClick={()=>setSelected([])}>清空</button></div>
    <div className={styles.options}>{MODULES.map(module=><label key={module.key}><input type="checkbox" checked={selected.includes(module.key)} disabled={disabled} onChange={event=>{const checked=event.target.checked;setSelected(previous=>checked?[...previous,module.key]:previous.filter(key=>key!==module.key))}}/><span>{module.label}</span></label>)}</div>
    {selected.length===0&&<p className={styles.note}>当前选择会使新用户没有可见业务模块。</p>}
   </>}
   <p className={styles.note}>新增模块自动加入列表，由管理员勾选是否默认开放。子页面跟随所属模块；用户统计等功能仍需原有访问资格，系统所有者始终可见全部模块。</p>
   {error&&<div><p className={styles.error} role="alert">{error}</p>{(!policy||conflict)&&<p className={styles.note}><button disabled={saving||loading} onClick={reload}>重新读取默认设置</button></p>}</div>}
   <footer><button disabled={saving} onClick={close}>取消</button><button className={styles.primary} disabled={disabled} onClick={()=>void save()}>{saving?'保存中…':'保存默认设置'}</button></footer>
  </div>
 </div>;
}
