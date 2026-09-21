'use client';
import {Children, Fragment, cloneElement, isValidElement, useId, useRef, useState, type CSSProperties, type DragEventHandler, type ReactElement, type ReactNode} from 'react';

export type MarketTableColumn={id:string;label:string;width:number;fixed?:boolean;stickyLeft?:number};
type CellProps={children?:ReactNode;style?:CSSProperties;'data-column-id'?:string;onDragOver?:DragEventHandler;onDrop?:DragEventHandler};

/** One order drives colgroup, headers, rows and totals; data and draft state stay with the caller. */
export function useMarketTableColumns(definitions:MarketTableColumn[], name:string){
 const [preferred,setPreferred]=useState<string[]>([]),[announcement,setAnnouncement]=useState('');
 const dragging=useRef<string|null>(null),instructionId=useId();
 const movable=definitions.filter(column=>!column.fixed);
 const ids=[...preferred.filter(id=>movable.some(column=>column.id===id)),...movable.filter(column=>!preferred.includes(column.id)).map(column=>column.id)];
 const columns=[...definitions.filter(column=>column.fixed),...ids.map(id=>movable.find(column=>column.id===id)!)];
 function move(source:string,target:string){
  const from=ids.indexOf(source),to=ids.indexOf(target);if(from<0||to<0||from===to)return;
  const next=[...ids];next.splice(from,1);next.splice(to,0,source);setPreferred(next);
  setAnnouncement(`${definitions.find(column=>column.id===source)!.label}已移至第 ${definitions.filter(column=>column.fixed).length+to+1} 列`);
 }
 function cells(children:ReactNode,header=false){
  const nodes=Children.toArray(isValidElement(children)&&children.type===Fragment?(children as ReactElement<CellProps>).props.children:children);
  return columns.map(column=>{
   const node=nodes[definitions.findIndex(candidate=>candidate.id===column.id)];if(!isValidElement(node))return node;
   const cell=node as ReactElement<CellProps>;
   const sticky=column.stickyLeft===undefined?{}:{position:'sticky' as const,left:column.stickyLeft,zIndex:header?10:4,background:header?'var(--table-head-bg, #f5f7fb)':'var(--card-bg, #fff)'};
   return cloneElement(cell,{key:column.id,'data-column-id':column.id,style:{...cell.props.style,...sticky},...(header&&!column.fixed?{
    onDragOver:(event)=>{if(dragging.current){event.preventDefault();event.dataTransfer.dropEffect='move';}},
    onDrop:(event)=>{event.preventDefault();if(dragging.current)move(dragging.current,column.id);dragging.current=null;},
   }: {})},header&&!column.fixed?<>{cell.props.children}<button type="button" draggable aria-label={`移动${column.label}列`} aria-describedby={instructionId} title="拖动调整列顺序；聚焦后按左右方向键移动" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:18,height:22,padding:0,marginLeft:3,border:0,borderRadius:3,background:'transparent',color:'var(--muted, #64748b)',cursor:'grab',verticalAlign:'middle'}} onDragStart={event=>{dragging.current=column.id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',column.id);}} onDragEnd={()=>{dragging.current=null;}} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const target=ids[ids.indexOf(column.id)+(event.key==='ArrowLeft'?-1:1)];if(target)move(column.id,target);}}}><svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" focusable="false"><path d="M3 3h.01M7 3h.01M3 7h.01M7 7h.01M3 11h.01M7 11h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg></button></>:cell.props.children);
  });
 }
 const controls=<div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',margin:'8px 0',fontSize:12,color:'var(--muted, #64748b)'}}><span id={instructionId}>拖动表头手柄调整列顺序，或聚焦手柄后按 ← →；身份列固定。</span><button type="button" className="ghost-btn" aria-label={`重置${name}列顺序`} disabled={!preferred.length} onClick={()=>{setPreferred([]);setAnnouncement('已恢复默认列顺序');}}>重置列顺序</button><span role="status" aria-live="polite" style={{position:'absolute',width:1,height:1,padding:0,overflow:'hidden',clipPath:'inset(50%)',whiteSpace:'nowrap'}}>{announcement}</span></div>;
 return {columns,cells,controls,minWidth:columns.reduce((sum,column)=>sum+column.width,0),colgroup:<colgroup>{columns.map(column=><col key={column.id} data-column-id={column.id} style={{width:column.width}}/>)}</colgroup>};
}
