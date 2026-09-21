"use client";
import {useEffect,useRef,useState} from 'react';
import {ALL_MODULES,MODULES,VisibilityPeopleResponseSchema,type ModuleKey,type VisibilityPeopleResponse,type VisibilityPerson} from '../../../shared/module-visibility-contracts';
import {saveModuleVisibility} from '../../lib/module-visibility-save';
import {localAgentFetch} from '../../lib/local-agent-browser';
import {useModalInteraction} from '../../lib/use-modal-interaction';
import styles from './module-visibility-panel.module.css';
import {NewUserModuleDefaults} from './new-user-module-defaults';

export function ModuleVisibilityPanel({sessionIdentity}:{sessionIdentity:string}){
 const [search,setSearch]=useState(''),[q,setQ]=useState(''),[page,setPage]=useState(1),[revision,setRevision]=useState(0);
 const [data,setData]=useState<VisibilityPeopleResponse|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [targets,setTargets]=useState<VisibilityPerson[]>([]),[selected,setSelected]=useState<ModuleKey[]>([]),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState('');
 const [defaultsOpen,setDefaultsOpen]=useState(false);
 const [statisticsGrant,setStatisticsGrant]=useState(false);
 const [editStatisticsGrant,setEditStatisticsGrant]=useState(false);
 const [checkedIds,setCheckedIds]=useState<string[]>([]);
 const person=targets[0]??null;
 const editablePeople=data?.people.filter(user=>!user.isSystemOwner)??[];
 const selectedPeople=editablePeople.filter(user=>checkedIds.includes(user.userId));
 const allChecked=editablePeople.length>0&&selectedPeople.length===editablePeople.length;
 const selectAll=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(selectAll.current)selectAll.current.indeterminate=selectedPeople.length>0&&!allChecked},[selectedPeople.length,allChecked]);
 const dialog=useRef<HTMLDivElement>(null);useModalInteraction(Boolean(person),dialog);
 const saveGeneration=useRef(0);
 useEffect(()=>()=>{saveGeneration.current++},[sessionIdentity]);
 useEffect(()=>{if(search.trim()===q)return;const timer=setTimeout(()=>{setQ(search.trim());setPage(1)},250);return()=>clearTimeout(timer)},[search,q]);
 useEffect(()=>{
  const request=new AbortController();let current=true;
  // Each query or identity change invalidates the previous loading and selection state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setLoading(true);setError('');setCheckedIds([]);
  void localAgentFetch('/v1/admin/module-visibility?'+new URLSearchParams({q,page:String(page)}),{signal:request.signal})
   .then(async response=>{if(!response.ok)throw new Error(response.status===403?'无权配置模块可见性':'读取失败，请重试');return VisibilityPeopleResponseSchema.parse(await response.json())})
   .then(result=>{if(current)setData(result)})
   .catch(e=>{if(current){setData(null);setError(e instanceof Error?e.message:'读取失败')}})
   .finally(()=>{if(current)setLoading(false)});
  return()=>{current=false;request.abort()};
 },[q,page,revision,sessionIdentity]);
 const open=(people:VisibilityPerson[])=>{
  if(!people.length||loading||people.some(user=>user.isSystemOwner))return;
  setTargets(people);
  setStatisticsGrant(people.length===1&&people[0].statisticsViewGranted);
  setEditStatisticsGrant(people.length===1);
  setSelected(ALL_MODULES.filter(key=>people.every(user=>user.visibleModules.includes(key))));
  setSaveError('');setMessage('');
 };
 const close=()=>{if(!saving)setTargets([])};
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!saving)setTargets([])};if(person)window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[person,saving]);
 const save=async()=>{
  if(!person||saving)return;
  const generation=saveGeneration.current;setSaving(true);setSaveError('');
  const failed:VisibilityPerson[]=[],failures:string[]=[];
  let succeeded=0;
  for(const target of targets){
   if(generation!==saveGeneration.current)return;
   try{
    await saveModuleVisibility(target,{visibleModules:ALL_MODULES.filter(key=>selected.includes(key)),version:target.version,...(editStatisticsGrant?{statisticsViewGranted:statisticsGrant&&selected.includes('admin-users')}:{})});succeeded++;
   }catch(e){failed.push(target);failures.push(target.displayName+'：'+(e instanceof Error?e.message:'保存失败'))}
  }
  if(generation!==saveGeneration.current)return;
  setSaving(false);setRevision(value=>value+1);
  if(failed.length){
   setTargets(failed);
   setSaveError((succeeded?'已确认 '+succeeded+' 人，剩余 '+failed.length+' 人未完成确认。':'')+failures.join('；'));
  }else{
   setMessage((targets.length===1?person.displayName:targets.length+' 人')+(editStatisticsGrant?'的模块显示与统计查看授权已保存，对方刷新页面后生效。':'的模块显示设置已保存，统计授权未修改。对方刷新页面后生效。'));setTargets([]);
  }
 };
 return <section className={styles.panel} aria-label="模块可见性配置">
  <div className={styles.heading}><div><h2>按人员设置可见模块</h2><p>勾选后显示模块；钉钉新用户使用注册时的默认设置，现有钉钉人员可单独调整。</p></div><button disabled={Boolean(person)} onClick={()=>{setMessage('');setDefaultsOpen(true)}}>新用户默认模块</button></div>
  <div className={styles.toolbar}><label>搜索人员<input type="search" placeholder="输入姓名或账号" maxLength={100} value={search} onChange={event=>setSearch(event.target.value)}/></label><button onClick={()=>setRevision(value=>value+1)} disabled={loading}>{loading?'读取中…':'刷新'}</button></div>
  <div className={styles.selectionBar}>
   <label><input ref={selectAll} type="checkbox" aria-label="全选当前页" disabled={loading||!editablePeople.length} checked={allChecked} onChange={event=>setCheckedIds(event.target.checked?editablePeople.map(user=>user.userId):[])}/>全选当前页</label>
   <span>已选 {selectedPeople.length} 人</span>
   <button disabled={loading||!selectedPeople.length} onClick={()=>open(selectedPeople)}>批量配置可见模块</button>
  </div>
  {message&&<p className={styles.success} role="status">{message}</p>}
  {error&&<p className={styles.error} role="alert">{error}</p>}
  {data?.people.length?<div className={styles.people}>{data.people.map(user=><article key={user.userId}><input className={styles.personCheckbox} type="checkbox" aria-label={"选择 "+user.displayName+" "+user.account} disabled={loading||user.isSystemOwner} checked={checkedIds.includes(user.userId)} onChange={event=>{const checked=event.target.checked;setCheckedIds(previous=>checked?[...previous,user.userId]:previous.filter(id=>id!==user.userId));}}/><div className={styles.identity}><span aria-hidden="true">{user.displayName.slice(0,1)}</span><div><strong>{user.displayName}</strong><small className={styles.account} title={user.account}>{user.account}</small><small>{user.isSystemOwner?'系统所有者 · 不可降权':user.configurationSource==='new-user-default'?'注册时默认配置':user.configured?'已单独配置':'默认显示'} · {user.visibleModules.length} / {MODULES.length} 个模块</small></div></div><div className={styles.tags}>{user.visibleModules.length?MODULES.filter(module=>user.visibleModules.includes(module.key)).map(module=><span key={module.key}>{module.label}</span>):<span>全部隐藏</span>}</div><button disabled={loading||user.isSystemOwner} onClick={()=>open([user])}>{user.isSystemOwner?"最高权限 · 已锁定":"配置可见模块"}</button></article>)}</div>:!loading&&!error?<p className={styles.empty}>没有找到钉钉人员</p>:loading&&!data?<p className={styles.empty}>正在加载…</p>:null}
  <nav className={styles.pagination} aria-label="可见性人员分页"><span>共 {data?.total??0} 人 · 每页 10 人</span><button disabled={loading||!data||data.page<=1} onClick={()=>setPage((data?.page??1)-1)}>上一页</button><span>{data?.page??1} / {Math.max(1,Math.ceil((data?.total??0)/10))}</span><button disabled={loading||!data||data.page*10>=data.total} onClick={()=>setPage((data?.page??1)+1)}>下一页</button></nav>
  {defaultsOpen&&<NewUserModuleDefaults key={sessionIdentity} onClose={()=>setDefaultsOpen(false)} onSaved={()=>{setDefaultsOpen(false);setMessage('新用户默认模块已保存，仅对之后新建的钉钉账号生效；现有用户及本地账号配置不变。')}}/>}
  {person&&<div className={styles.backdrop} onMouseDown={event=>{if(event.target===event.currentTarget)close()}}>
   <div ref={dialog} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="visibility-title" tabIndex={-1}>
    <header><div><h2 id="visibility-title">{targets.length>1?"批量配置 · "+targets.length+" 人":person.displayName+" · 可见模块"}</h2><p>{targets.length>1?targets.map(user=>user.displayName).join("、"):person.account}</p></div><button aria-label="关闭配置" disabled={saving} onClick={close}>×</button></header>
    {targets.length>1&&<p className={styles.note}>初始勾选为所选人员共同显示的模块。保存后将统一替换这 {targets.length} 人的可见模块，请核对选择。</p>}<div className={styles.bulk}><span>已选择 {selected.length} / {MODULES.length}</span><button disabled={saving} onClick={()=>setSelected([...ALL_MODULES])}>全选</button><button disabled={saving} onClick={()=>{setSelected([]);setStatisticsGrant(false)}}>清空</button></div>
    <div className={styles.options}>{MODULES.map(module=><label key={module.key}><input type="checkbox" checked={selected.includes(module.key)} disabled={saving} onChange={event=>{const checked=event.target.checked;if(module.key==='admin-users'&&!checked)setStatisticsGrant(false);setSelected(previous=>checked?[...previous,module.key]:previous.filter(key=>key!==module.key));}}/><span>{module.label}</span></label>)}</div>
    {editStatisticsGrant?<div className={styles.options}><label><input type="checkbox" checked={statisticsGrant&&selected.includes('admin-users')} disabled={saving} onChange={event=>{setStatisticsGrant(event.target.checked);if(event.target.checked)setSelected(previous=>previous.includes('admin-users')?previous:[...previous,'admin-users']);}}/><span>允许查看用户与使用统计</span></label><p className={styles.note}>允许查看本组织人员的账号、在线与登录状态、页面使用及分析用量；不授予模块配置或其他管理权限。取消后，此项授权立即失效，对方刷新后更新入口。系统所有者与原指定人员的既有授权不受此开关影响。</p></div>:<p className={styles.note}>批量配置只调整模块显示，不修改统计查看授权；如需授权，请逐人打开配置。</p>}
    <p className={styles.note}>父模块与子页面一起显示或隐藏。仅勾选上方“用户与使用统计”不授予查看权限，需同时开启下方授权。收藏中的业务页面遵循对应模块设置。</p>
    {selected.length===0&&<p className={styles.note}>当前选择会隐藏全部业务模块。</p>}
    {saveError&&<p role="alert" className={styles.error}>{saveError}</p>}
    <footer><button disabled={saving} onClick={close}>取消</button><button className={styles.primary} disabled={saving} onClick={()=>void save()}>{saving?'保存中…':'保存设置'}</button></footer>
   </div>
  </div>}
 </section>;
}
