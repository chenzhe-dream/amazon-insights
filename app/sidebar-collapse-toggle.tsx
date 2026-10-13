"use client";
export function SidebarCollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return <button type="button" className="sidebar-collapse-toggle" onClick={onToggle} aria-expanded={!collapsed} aria-controls="primary-navigation" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"}>
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d={collapsed ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"}/></svg>
    <span>{collapsed ? "展开侧栏" : "收起侧栏"}</span>
  </button>;
}
