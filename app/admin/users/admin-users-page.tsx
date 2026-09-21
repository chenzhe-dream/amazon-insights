"use client";
import {useCallback,useEffect,useState} from "react";

import { AuthSessionGate } from "../../auth-session-gate";
import {
  AdminUsersAuthenticatedPage,
  type AdminUserPresenceClassNames,
} from "./admin-user-presence";
import styles from "./admin-users.module.css";
import {UsageAnalyticsPanel} from "./usage-analytics-panel";
import {UserPresencePanel} from "./user-presence-panel";
import {publishUsagePage} from "../../lib/usage-analytics-browser";
import type {AuthenticatedWebSession} from "../../auth-session-gate";
import {ModuleVisibilityPanel} from './module-visibility-panel';
import {isModuleVisible} from '../../../shared/module-visibility-contracts';

const adminUserPresenceClasses = styles as unknown as AdminUserPresenceClassNames;

function ManagementContent({session}:{session:AuthenticatedWebSession}){
  const canShowStats=session.canViewUserPresence&&isModuleVisible(session.visibleModules,'admin-users');
  const canManage=session.canManageModuleVisibility===true;
  const [view,setView]=useState<"presence"|"usage"|"visibility">(canShowStats?'presence':'visibility');
  const [restored,setRestored]=useState(false);
  useEffect(()=>{
    const restore=()=>{
      const requested=new URL(location.href).searchParams.get('view');
      setView(requested==='visibility'&&canManage?'visibility':canShowStats?(requested==='usage'?'usage':'presence'):'visibility');
    };
    restore();setRestored(true);window.addEventListener('popstate',restore);
    return()=>window.removeEventListener('popstate',restore);
  },[canManage,canShowStats]);
  const selectView=(next:"presence"|"usage"|"visibility")=>{
    setView(next);const url=new URL(location.href);url.searchParams.set('view',next);
    window.history.replaceState(window.history.state,'',url);
  };
  useEffect(()=>{if(restored)publishUsagePage(view==="usage"?"admin-usage":"admin-users")},[view,restored]);
  const onForbidden=useCallback(()=>session.revokeUserPresenceAccess(session.sessionIdentity),[session.revokeUserPresenceAccess,session.sessionIdentity]);
  return <>
    <nav className={styles.managementTabs} aria-label="管理视图">
      {canShowStats&&<button type="button" aria-pressed={view==="presence"} onClick={()=>selectView("presence")}>用户状态</button>}
      {canShowStats&&<button type="button" aria-pressed={view==="usage"} onClick={()=>selectView("usage")}>使用统计</button>}
      {canManage&&<button type="button" aria-pressed={view==="visibility"} onClick={()=>selectView("visibility")}>模块可见性</button>}
    </nav>
    {view==='visibility'&&canManage?<ModuleVisibilityPanel key={session.sessionIdentity} sessionIdentity={session.sessionIdentity}/>:canShowStats?(view==="usage"?<UsageAnalyticsPanel key={session.sessionIdentity} sessionIdentity={session.sessionIdentity}/>:<>
      <UserPresencePanel sessionIdentity={session.sessionIdentity} onForbidden={onForbidden}/>
    </>):<p role="status">此模块未设置为显示。</p>}
  </>;
}

export function AdminUsersPageBoundary() {
  return (
    <AuthSessionGate>
      {(session) => <AdminUsersAuthenticatedPage session={session} classes={adminUserPresenceClasses} adminContent={session.canViewUserPresence||session.canManageModuleVisibility?<ManagementContent key={session.sessionIdentity} session={session}/>:undefined} />}
    </AuthSessionGate>
  );
}
