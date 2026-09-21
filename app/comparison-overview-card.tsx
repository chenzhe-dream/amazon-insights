"use client";

import {useEffect, useId, useRef, useState, type ReactNode} from "react";
import "./comparison-overview-card.css";

/** The same table stays mounted: expanding must not repeat paid data requests. */
export function ComparisonOverviewCard({description, badge, children}: {
  description: ReactNode;
  badge: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [expanded]);

  function toggleFullscreen() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialog.open) {
      dialog.close();
    } else {
      const matrix = dialog.querySelector(".matrix-wrap");
      const scroll = matrix ? {top: matrix.scrollTop, left: matrix.scrollLeft} : null;
      dialog.showModal();
      setExpanded(true);
      buttonRef.current?.focus({preventScroll: true});
      if (matrix && scroll) matrix.scrollTo({top: scroll.top, left: scroll.left});
    }
  }

  return <dialog
    ref={dialogRef}
    className="card compare-table-card comparison-overview-shell"
    role={expanded ? "dialog" : "region"}
    aria-modal={expanded ? true : undefined}
    aria-labelledby={titleId}
    onKeyDown={event => {
      if (!expanded || event.key !== "Tab" || event.defaultPrevented) return;
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
        .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }}
    onClose={() => {
      setExpanded(false);
      buttonRef.current?.focus({preventScroll: true});
    }}
  >
    <div className="section-head">
      <div><h3 id={titleId}>竞品参数总览</h3><p>{description}</p></div>
      <div className="comparison-overview-actions">
        {badge}
        <button ref={buttonRef} type="button" className="comparison-overview-expand" aria-expanded={expanded} onClick={toggleFullscreen}>
          <span aria-hidden="true">{expanded ? "↙" : "⛶"}</span> {expanded ? "退出全屏" : "全屏查看"}
        </button>
      </div>
    </div>
    {children}
  </dialog>;
}
