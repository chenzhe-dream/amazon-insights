"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export function CategoryChartDialog({ title, description, onClose, children }: {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialogRef} className="category-chart-dialog" aria-labelledby={titleId} onClose={onClose}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        event.currentTarget.close();
      }
    }}>
    <header className="category-chart-dialog-head">
      <div><h3 id={titleId}>{title}</h3><p>{description}</p></div>
      <button type="button" className="ghost-btn" autoFocus onClick={() => dialogRef.current?.close()}>关闭放大</button>
    </header>
    <div className="category-chart-dialog-scroll">{children}</div>
  </dialog>;
}
