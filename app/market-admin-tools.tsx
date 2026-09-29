'use client';
import React,{createContext,useContext,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

const AdminToolsContext=createContext<{enabled:boolean;target:HTMLDivElement|null}>({enabled:false,target:null});

/** The authenticated page supplies enabled; no URL or browser preference grants access. */
export function MarketAdminTools({enabled,children}:{enabled:boolean;children:ReactNode}){
 const [target,setTarget]=useState<HTMLDivElement|null>(null);
 return <AdminToolsContext.Provider value={{enabled,target:enabled?target:null}}>
  {children}
  {enabled&&<details className="market-admin-tools" aria-label="管理员工具">
   <summary>管理员工具<span>数据核对与任务管理</span></summary>
   <div className="market-admin-tools-body" ref={setTarget}/>
  </details>}
 </AdminToolsContext.Provider>;
}

export function useMarketAdminTools(){return useContext(AdminToolsContext).enabled;}

/** Keep the original component state and callbacks while collecting auxiliary UI in one panel. */
export function MarketAdminContent({children}:{children:ReactNode}){
 const {enabled,target}=useContext(AdminToolsContext);
 return enabled&&target?createPortal(children,target):null;
}
