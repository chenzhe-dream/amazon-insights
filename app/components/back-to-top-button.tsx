"use client";

import { useState, useEffect } from "react";

export function BackToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 420);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      className={`back-to-top-btn${visible ? " visible" : ""}`}
      aria-label="返回顶部"
      title="返回顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M12 6.5v11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <path d="m7.8 11 4.2-4.3L16.2 11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>顶部</span>
    </button>
  );
}
