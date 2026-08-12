"use client";

import type { ReactNode } from "react";

export function LaunchSection({
  title,
  description,
  badge,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card launch-block ${className}`.trim()}>
      <div className="launch-section-head">
        <div className="launch-section-head-main">
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {badge}
      </div>
      <div className="launch-section-body">{children}</div>
    </section>
  );
}

export function LaunchTable({
  className = "",
  stickyHeader = false,
  maxHeight = "min(68vh, 560px)",
  children,
}: {
  className?: string;
  /** 表头吸顶：外层限高滚动，下滑时仍能看到列名 */
  stickyHeader?: boolean;
  maxHeight?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`launch-table-wrap${stickyHeader ? " launch-table-wrap-sticky" : ""}`.trim()}
      style={stickyHeader ? { maxHeight } : undefined}
    >
      <table className={`launch-table ${className}`.trim()}>{children}</table>
    </div>
  );
}
