"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export const TOP_SALES_COLUMNS = [
  ["bulk", 65], ["rank", 44], ["product", 240], ["brand", 88],
  ["shape", 120], ["launch", 72], ["margin", 72], ["entry", 108], ["price", 80],
  ["band", 92], ["sales30", 96], ["amount30", 112], ["trend", 128],
  ["last3", 88], ["last6", 88], ["y2025", 72], ["y2024", 72],
  ["rating", 48], ["reviews", 68], ["delivery", 56], ["seller", 96], ["action", 70],
] as const;
export type TopSalesColumnId = (typeof TOP_SALES_COLUMNS)[number][0];

const WIDTHS_KEY = 'market-shape-reference-column-widths/v1';
const clampWidth = (width: number, id: TopSalesColumnId) => Math.min(560, Math.max(id === "shape" ? 96 : 40, Math.round(width)));
/** Column sizes are browser display preferences, independent of report data. */
export function useReferenceColumnWidths() {
  const [widths, setWidths] = useState<Record<TopSalesColumnId, number>>(
    () => Object.fromEntries(TOP_SALES_COLUMNS.map(([id, width]) => [id, width])) as Record<TopSalesColumnId, number>,
  );
  const widthsRef=useRef(widths);
  useEffect(()=>{
    // Restore browser-only preferences after the initial hydrated render.
    const frame=requestAnimationFrame(()=>{try{
      const stored:unknown=JSON.parse(localStorage.getItem(WIDTHS_KEY)??'null');
      if(stored&&typeof stored==='object'&&!Array.isArray(stored)){
        const next={...widthsRef.current,...Object.fromEntries(TOP_SALES_COLUMNS.flatMap(([id])=>{const value=(stored as Record<string,unknown>)[id];return typeof value==='number'&&Number.isFinite(value)?[[id,clampWidth(value,id)]]:[]}))};
        widthsRef.current=next;setWidths(next);
      }
    }catch{/* Restricted or invalid storage keeps defaults. */}});
    return()=>cancelAnimationFrame(frame);
  },[]);
  const setWidth = (id: TopSalesColumnId, width: number) => {
    const next={...widthsRef.current,[id]:clampWidth(width,id)};
    widthsRef.current=next;setWidths(next);
    try{localStorage.setItem(WIDTHS_KEY,JSON.stringify(next));}catch{/* Resizing works without storage. */}
  };
  return { widths, setWidth };
}

export function ResizeHeader({ id, width, onWidth, children, stickyLeft }: { id: TopSalesColumnId; width: number; onWidth: (id: TopSalesColumnId, width: number) => void; children: ReactNode; stickyLeft?: number }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return <th data-column-id={id} className={stickyLeft == null ? undefined : 'shape-ref-frozen'} style={{ width, minWidth: width, maxWidth: width, position: "sticky", top: 0, left: stickyLeft, zIndex: stickyLeft == null ? 3 : 4 }}>
    {children}<span role="separator" aria-label={`调整${id}列宽`} aria-orientation="vertical" tabIndex={0}
      className="top-sales-column-resizer" style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "col-resize", touchAction: "none" }}
      onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
      onPointerMove={event => { if (drag.current) onWidth(id, drag.current.width + event.clientX - drag.current.x); }}
      onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }}
      onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onWidth(id, width + (event.key === "ArrowRight" ? 10 : -10)); } }} />
  </th>;
}
