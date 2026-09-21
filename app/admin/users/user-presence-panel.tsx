"use client";

import {Fragment,useEffect,useState} from 'react';
import {AdminUserPresenceResponseSchema,type AdminUserPresenceResponse,type AdminUserPresenceUser,type PresenceStatus} from '../../../shared/agent-contracts';
import {PresenceQuerySchema,type PresenceQuery} from '../../../shared/admin-user-presence-query';
import {localAgentFetch} from '../../lib/local-agent-browser';
import {formatPresenceTime} from './admin-user-presence';
import styles from './user-presence-panel.module.css';

const labels:Record<PresenceStatus,string>={
 'recently-online':'近期有活动','valid-session-idle':'暂未活动','never-logged-in':'从未登录','session-expired':'会话已失效',disabled:'已停用',
};
const invalidation={expired:'已过期',revoked:'已撤销','account-disabled':'账号已停用'};

function LoginHistory({user}:{user:AdminUserPresenceUser}){
 return <div className={styles.history}>
  <div className={styles.historyHeading}><strong>{user.displayName}的登录记录</strong><span>累计登录 {user.loginCount} 次 · 有效会话到期：{formatPresenceTime(user.validSessionExpiresAt)}</span></div>
  {user.recentLogins.length===0?<p className={styles.muted}>暂无登录记录</p>:<div className={styles.historyScroll}><table aria-label={user.displayName+' 最近登录记录'}>
   <thead><tr><th>登录时间</th><th>最后活动</th><th>到期时间</th><th>状态</th></tr></thead>
   <tbody>{user.recentLogins.map((record,i)=><tr key={record.loggedInAt+i}><td>{formatPresenceTime(record.loggedInAt)}</td><td>{formatPresenceTime(record.lastActivityAt)}</td><td>{formatPresenceTime(record.expiresAt)}</td><td>{record.invalidationReason?invalidation[record.invalidationReason]:'有效'}</td></tr>)}</tbody>
  </table></div>}
 </div>;
}

export function UserPresencePanel({sessionIdentity,onForbidden}:{sessionIdentity:string;onForbidden:()=>void}){
 const [query,setQuery]=useState<PresenceQuery>(()=>PresenceQuerySchema.parse({}));
 const [search,setSearch]=useState(''),[refresh,setRefresh]=useState(0);
 const [data,setData]=useState<AdminUserPresenceResponse|null>(null);
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[expanded,setExpanded]=useState<string|null>(null);
 useEffect(()=>{const timer=setTimeout(()=>setQuery(previous=>previous.q===search.trim()?previous:{...previous,q:search.trim(),page:1}),250);return()=>clearTimeout(timer)},[search]);
 useEffect(()=>{
  const controller=new AbortController();let current=true;
  setLoading(true);setError('');setExpanded(null);
  const parameters=new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)]));
  void localAgentFetch('/v1/admin/users?'+parameters,{signal:controller.signal}).then(async response=>{
   if(!current)return;
   if(response.status===403){setData(null);onForbidden();throw new Error('无权查看用户状态');}
   if(!response.ok)throw new Error('读取失败，请重试');
   const parsed=AdminUserPresenceResponseSchema.parse(await response.json());
   if(current)setData(parsed);
  }).catch(()=>{if(current)setError('用户状态暂时无法刷新，请重试。')}).finally(()=>{if(current)setLoading(false)});
  return()=>{current=false;controller.abort()};
 },[query,refresh,sessionIdentity,onForbidden]);
 const pagination=data?.pagination??{page:1,pageSize:query.pageSize,total:0};
 const pageCount=Math.max(1,Math.ceil(pagination.total/pagination.pageSize));
 const change=(patch:Partial<PresenceQuery>)=>setQuery(previous=>({...previous,...patch,page:1}));
 const summary=data?.summary;
 const start=Math.max(1,Math.min(pagination.page-2,pageCount-4));
 const pages=Array.from({length:Math.min(5,pageCount)},(_,i)=>start+i);
 const clear=()=>{setSearch('');setQuery(PresenceQuerySchema.parse({}))};
 return <section className={styles.panel} aria-label="用户状态">
  <div className={styles.metrics}>
   {[{label:'人员总数',value:summary?.total,status:'all'},{label:'近期有活动',value:summary?.recentlyOnline,status:'recently-online'},{label:'从未登录',value:summary?.neverLoggedIn,status:'never-logged-in'}].map(item=>
    <button type="button" key={item.status} aria-pressed={query.status===item.status} onClick={()=>change({status:item.status as PresenceQuery['status']})}><span>{item.label}</span><strong>{item.value??'—'}</strong><small>{item.status==='recently-online'?'最近 15 分钟':'当前搜索与账号来源'}</small></button>)}
  </div>
  <div className={styles.listCard}>
   <div className={styles.toolbar}>
    <label className={styles.search}><span>搜索人员</span><input type="search" placeholder="搜索姓名或账号" value={search} maxLength={100} onChange={event=>setSearch(event.target.value)}/></label>
    <label><span>活动状态</span><select value={query.status} onChange={event=>change({status:event.target.value as PresenceQuery['status']})}><option value="all">全部状态</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <label><span>账号来源</span><select value={query.source} onChange={event=>change({source:event.target.value as PresenceQuery['source']})}><option value="dingtalk">钉钉人员</option><option value="all">全部人员</option><option value="local">历史本地账号</option></select></label>
    <button type="button" className={styles.refresh} disabled={loading} onClick={()=>setRefresh(value=>value+1)}>{loading?'读取中…':'刷新'}</button>
   </div>
   <div className={styles.listInfo}><span>人员列表 <strong>{pagination.total}</strong></span><small>{data?'更新于 '+formatPresenceTime(data.asOf):'正在读取人员列表'}</small></div>
   {error&&<div role="alert" className={styles.error}>{error} {data?'以下保留上次成功结果。':''}<button onClick={()=>setRefresh(value=>value+1)}>重试</button></div>}
   <div className={styles.tableArea} aria-busy={loading}>
    {!data&&loading?<div className={styles.empty} role="status">正在加载用户状态…</div>:data?.users.length?<table className={styles.peopleTable} aria-label="人员列表">
     <thead><tr><th>人员</th><th>活动状态</th><th>角色</th><th>最后活动</th><th>最后登录</th><th>操作</th></tr></thead>
     <tbody>{data.users.map(user=><Fragment key={user.account}>
      <tr className={styles.personRow}>
       <td data-label="人员"><div className={styles.person}><span className={styles.avatar} aria-hidden="true">{user.displayName.slice(0,1)}</span><div><strong>{user.displayName}</strong><small>{user.source==='dingtalk'?'钉钉账号':user.account}</small></div></div></td>
       <td data-label="活动状态"><span className={styles.badge} data-status={user.presenceStatus}>{labels[user.presenceStatus]}</span></td>
       <td data-label="角色"><span className={styles.role}>{user.role==='admin'?'管理员':'成员'}</span></td>
       <td data-label="最后活动" className={styles.time}>{formatPresenceTime(user.lastActivityAt)}</td>
       <td data-label="最后登录" className={styles.time}>{formatPresenceTime(user.lastLoginAt)}</td>
       <td data-label="操作"><button className={styles.detailButton} aria-expanded={expanded===user.account} onClick={()=>setExpanded(value=>value===user.account?null:user.account)}>{expanded===user.account?'收起记录':'登录记录'}</button></td>
      </tr>
      {expanded===user.account&&<tr className={styles.expandedRow}><td colSpan={6}><LoginHistory user={user}/></td></tr>}
     </Fragment>)}</tbody>
    </table>:!error?<div className={styles.empty}><strong>{query.q||query.status!=='all'?'没有找到符合条件的人员':'暂无人员'}</strong><p>可以调整搜索词或账号来源。</p><button onClick={clear}>重置筛选</button></div>:null}
   </div>
   <nav className={styles.pagination} aria-label="人员分页">
    <span>{pagination.total?((pagination.page-1)*pagination.pageSize+1):0}–{Math.min(pagination.page*pagination.pageSize,pagination.total)} / 共 {pagination.total} 人</span>
    <label>每页 <select aria-label="每页人数" value={query.pageSize} onChange={event=>change({pageSize:Number(event.target.value) as PresenceQuery['pageSize']})}>{[10,20,50].map(size=><option key={size} value={size}>{size}</option>)}</select> 人</label>
    <div className={styles.pageButtons}>
     <button disabled={loading||pagination.page<=1} onClick={()=>setQuery(previous=>({...previous,page:pagination.page-1}))}>上一页</button>
     {pages.map(page=><button key={page} aria-label={'第 '+page+' 页'} aria-current={pagination.page===page?'page':undefined} disabled={loading} onClick={()=>setQuery(previous=>({...previous,page}))}>{page}</button>)}
     <button disabled={loading||pagination.page>=pageCount} onClick={()=>setQuery(previous=>({...previous,page:pagination.page+1}))}>下一页</button>
    </div>
   </nav>
  </div>
  <p className={styles.footnote}>活动记录每 10 分钟批量更新；近期活动表示最近 15 分钟使用过本系统，不代表钉钉在线。</p>
 </section>;
}
