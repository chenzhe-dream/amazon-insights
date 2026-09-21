"use client";
import {useEffect,useId,useRef,useState} from "react";
import type {UsagePerson} from "../../../shared/usage-analytics-contracts";
import {highlightParts,searchUsagePeople} from "../../lib/usage-analytics-query";
import styles from "./usage-analytics.module.css";
export function PersonSearch({value,onChange}:{value:UsagePerson|null;onChange:(value:UsagePerson|null)=>void}){
  const id=useId(),[text,setText]=useState(value?.displayName??""),[open,setOpen]=useState(false),[items,setItems]=useState<UsagePerson[]>([]),[more,setMore]=useState(false),[active,setActive]=useState(-1),[loading,setLoading]=useState(false),[error,setError]=useState("");
  const input=useRef<HTMLInputElement>(null),cache=useRef(new Map<string,{at:number;people:UsagePerson[];hasMore:boolean}>()),generation=useRef(0);
  useEffect(()=>{
    if(!open)return;const key=text.trim().toLowerCase(),cached=cache.current.get(key),controller=new AbortController(),current=++generation.current;
    setActive(-1);setError("");setItems([]);
    if(cached&&Date.now()-cached.at<60_000){setItems(cached.people);setMore(cached.hasMore);setLoading(false);return}
    setLoading(true);
    const timer=setTimeout(()=>{void searchUsagePeople(text,controller.signal).then(result=>{if(controller.signal.aborted||current!==generation.current)return;cache.current.set(key,{...result,at:Date.now()});setItems(result.people);setMore(result.hasMore);setLoading(false)}).catch(e=>{if(!controller.signal.aborted&&current===generation.current){setError(e instanceof Error?e.message:"搜索失败");setLoading(false)}})},300);
    return()=>{clearTimeout(timer);controller.abort()};
  },[text,open]);
  function close(){setOpen(false);setText(value?.displayName??"")}
  function select(person:UsagePerson){onChange(person);setText(person.displayName);setOpen(false)}
  const highlight=(label:string)=>highlightParts(label,text).map((p,i)=>p.hit?<mark key={i}>{p.text}</mark>:<span key={i}>{p.text}</span>);
  return <div className={styles.search} data-usage-ignore onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))close()}}>
    <label htmlFor={id}>人员</label><div className={styles.searchBox}>
      <input id={id} ref={input} role="combobox" aria-label="搜索钉钉人员姓名或标识" aria-expanded={open} aria-controls={id+"-options"} aria-autocomplete="list" aria-activedescendant={active>=0?id+"-"+active:undefined} autoComplete="off" placeholder="搜索姓名 / 人员标识" value={text}
        onFocus={()=>setOpen(true)} onChange={e=>{setText(e.target.value);setOpen(true);setItems([]);if(!e.target.value)onChange(null)}}
        onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==="Escape"){close();return}if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();setOpen(true);setActive(n=>items.length?(n+(e.key==="ArrowDown"?1:-1)+items.length)%items.length:-1)}if(e.key==="Enter"&&open){e.preventDefault();const item=items[active>=0?active:0];if(item)select(item)}}}/>
      {(text||value)&&<button type="button" aria-label="清空人员筛选" onClick={()=>{setText("");onChange(null);setOpen(true);input.current?.focus()}}>×</button>}
      {open&&<div className={styles.suggestions}>
        <p role="status">{loading?"正在搜索…":error||("命中 "+items.length+" 位人员"+(more?"，请继续输入":""))}<small>当前：{value?.displayName??"全部人员"}</small></p>
        <div role="listbox" id={id+"-options"} aria-label="关键词命中人员">
          {!loading&&!error&&!items.length&&<p>未找到匹配人员，请更换关键词。</p>}
          {items.map((person,i)=><button id={id+"-"+i} key={person.userId} type="button" role="option" aria-selected={i===active} onPointerDown={e=>e.preventDefault()} onClick={()=>select(person)}><strong>{highlight(person.displayName)}</strong><small>{highlight(person.personLabel)} · 钉钉已绑定</small></button>)}
        </div>
      </div>}
    </div>
  </div>;
}
