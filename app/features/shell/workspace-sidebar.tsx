"use client";

import { Fragment } from "react";
import { isNavGroup } from "./navigation";
import { NavThemeIcon, NavSubText } from "./navigation-presentation";
import Link from "next/link";
import { HelpFeedbackDrawer } from "../../help-feedback/help-feedback-drawer";
import { markets } from "../catalog/product-contracts";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type WorkspaceSidebarProps = Pick<WorkspaceController, "nav" | "flyoutGroupId" | "activeTab" | "openFlyout" | "scheduleCloseFlyout" | "toggleFlyout" | "tabHref" | "closeFlyout" | "authSession" | "market" | "products" | "flyoutPanelRef" | "flyoutOpen" | "activeFlyoutGroup" | "flyoutTop" | "clearFlyoutCloseTimer">;

export function WorkspaceSidebar({ nav, flyoutGroupId, activeTab, openFlyout, scheduleCloseFlyout, toggleFlyout, tabHref, closeFlyout, authSession, market, products, flyoutPanelRef, flyoutOpen, activeFlyoutGroup, flyoutTop, clearFlyoutCloseTimer }: WorkspaceSidebarProps) {
  return <div className="nav-rail">
    <aside className="sidebar">
      <div className="brand-mark">
        <span className="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" width={38} height={38} fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="brandTile" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
                <stop stopColor="#2B3648"/>
                <stop offset="1" stopColor="#1A2332"/>
              </linearGradient>
              <linearGradient id="brandAccent" x1="14" y1="30" x2="36" y2="14" gradientUnits="userSpaceOnUse">
                <stop stopColor="#FFB84D"/>
                <stop offset="1" stopColor="#FF9900"/>
              </linearGradient>
            </defs>
            <g>
              <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#brandTile)"/>
              {/* opportunity rising bars */}
              <path d="M12.5 31.5V27.2M17 31.5V23.5M21.5 31.5V20.2" stroke="#8FA0B5" strokeWidth="2.2" strokeLinecap="round"/>
              <path d="M12.5 26.2C16.8 26.2 19.2 20.8 23.8 18.6C27.6 16.8 30.2 14.2 33.8 12.4" stroke="url(#brandAccent)" strokeWidth="2.4" strokeLinecap="round"/>
              <path d="M29.6 12.2h4.8v4.8" stroke="url(#brandAccent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              {/* insight lens */}
              <circle cx="28.2" cy="27.8" r="6.4" stroke="#fff" strokeWidth="2.1"/>
              <path d="M32.8 32.4 36.6 36.2" stroke="#FF9900" strokeWidth="2.3" strokeLinecap="round"/>
              <circle cx="28.2" cy="27.8" r="2.1" fill="#FF9900"/>
            </g>
          </svg>
        </span>
        <div className="brand-copy">
          <strong>
            <span className="brand-amazon-logo">
              <img src="/amazon-logo.svg" alt="Amazon" width={88} height={27} />
            </span>
            产品机会洞察
          </strong>
        </div>
      </div>
      <nav>
        {nav.map(entry => (
          <Fragment key={entry.id}>
            {isNavGroup(entry) ? (
              <button
                type="button"
                data-dim={entry.id}
                aria-expanded={flyoutGroupId === entry.id}
                aria-controls="sidebar-flyout"
                className={`nav-item nav-group-trigger${entry.children.some(child => child.id === activeTab) || flyoutGroupId === entry.id ? " active" : ""}`}
                onMouseEnter={event => openFlyout(entry.id, event.currentTarget)}
                onMouseLeave={scheduleCloseFlyout}
                onFocus={event => openFlyout(entry.id, event.currentTarget)}
                onClick={event => toggleFlyout(entry.id, event.currentTarget)}
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    scheduleCloseFlyout();
                  }
                }}
              >
                <NavThemeIcon dim={entry.id} />
                <span className="nav-item-copy">
                  <b>{entry.label}</b>
                  <NavSubText text={entry.sub} />
                </span>
                <span className="nav-chevron" aria-hidden="true" />
              </button>
            ) : (
              <Link
                href={tabHref(entry.id)}
                data-dim={entry.id}
                className={activeTab === entry.id ? "nav-item active" : "nav-item"}
                onClick={closeFlyout}
              >
                <NavThemeIcon dim={entry.id} />
                <span className="nav-item-copy">
                  <b>{entry.label}</b>
                  <NavSubText text={entry.sub} />
                </span>
              </Link>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <HelpFeedbackDrawer user={authSession.user} />
        <div className="sync-status"><i/>数据源状态正常</div>
        <p>{markets[market].label} · 当前对比<br/><b>{products.length} 个 ASIN</b></p>
      </div>
    </aside>

    <aside
      id="sidebar-flyout"
      ref={flyoutPanelRef}
      className={`sidebar-flyout${flyoutOpen ? " open" : ""}`}
      aria-hidden={!flyoutOpen}
      aria-label={activeFlyoutGroup ? `${activeFlyoutGroup.label} 三级页面` : "三级导航"}
      style={{ top: flyoutTop }}
      onMouseEnter={clearFlyoutCloseTimer}
      onMouseLeave={scheduleCloseFlyout}
    >
      {activeFlyoutGroup ? (
        <div className="sidebar-flyout-list">
          {activeFlyoutGroup.children.map(child => (
            <Link
              key={child.id}
              href={tabHref(child.id)}
              data-dim={child.id}
              className={activeTab === child.id ? "sidebar-flyout-item active" : "sidebar-flyout-item"}
              onClick={closeFlyout}
            >
              <NavThemeIcon dim={child.id} />
              <span className="nav-item-copy">
                <b>{child.label}</b>
                <NavSubText text={child.sub} />
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </aside>
    </div>;
}
