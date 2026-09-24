"use client";

import { useRef, useState, type ReactNode } from "react";

export const TOP_SALES_COLUMNS = [
  ["include", 52], ["bulk", 45], ["rank", 50], ["product", 240], ["brand", 90],
  ["shape", 110], ["launch", 85], ["margin", 80], ["entry", 110], ["price", 80],
  ["band", 95], ["sales30", 105], ["amount30", 115], ["trend", 145],
  ["last3", 90], ["last6", 90], ["y2025", 90], ["y2024", 90],
  ["rating", 55], ["reviews", 75], ["delivery", 70], ["seller", 105], ["action", 70],
] as const;
export type TopSalesColumnId = (typeof TOP_SALES_COLUMNS)[number][0];

/** Matches the reference drag affordance; widths live only in the current view. */
export function useReferenceColumnWidths() {
  const [widths, setWidths] = useState<Record<TopSalesColumnId, number>>(
    () => Object.fromEntries(TOP_SALES_COLUMNS.map(([id, width]) => [id, width])) as Record<TopSalesColumnId, number>,
  );
  const setWidth = (id: TopSalesColumnId, width: number) => setWidths(current => ({ ...current, [id]: Math.min(560, Math.max(40, Math.round(width))) }));
  return { widths, setWidth };
}

export function ResizeHeader({ id, width, onWidth, children }: { id: TopSalesColumnId; width: number; onWidth: (id: TopSalesColumnId, width: number) => void; children: ReactNode }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return <th data-column-id={id} style={{ width, minWidth: width, maxWidth: width, position: "relative" }}>
    {children}<span role="separator" aria-label={`调整${id}列宽`} aria-orientation="vertical" tabIndex={0}
      className="top-sales-column-resizer" style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "col-resize", touchAction: "none" }}
      onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
      onPointerMove={event => { if (drag.current) onWidth(id, drag.current.width + event.clientX - drag.current.x); }}
      onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }}
      onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onWidth(id, width + (event.key === "ArrowRight" ? 10 : -10)); } }} />
  </th>;
}
