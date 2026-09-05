"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keep keyboard navigation and background scrolling scoped to an open modal. */
export function useModalInteraction(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const focusFirst = () => (initialFocusRef?.current ?? focusable()[0] ?? dialog).focus();
    document.body.style.overflow = "hidden";
    focusFirst();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [dialogRef, initialFocusRef, open]);
}
