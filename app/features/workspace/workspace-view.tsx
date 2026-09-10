"use client";

import { groupIdForTab } from "../shell/navigation";
import { ConcurrencyAdminPanel } from "../../concurrency-admin-panel";
import { markets } from "../catalog/product-contracts";
import { SourceBadge } from "../../components/source-badge";
import { BackToTopButton } from "../../components/back-to-top-button";
import type { WorkspaceController } from "./use-workspace-controller";
import { WorkspaceSidebar } from "../shell/workspace-sidebar";
import { WorkspaceTopbar } from "../shell/workspace-topbar";
import { OverviewTab } from "../catalog/overview-tab";
import { ListingTab } from "../listing/listing-tab";
import { VocTab } from "../voc/voc-tab";
import { KeywordsTab, KeywordInsightTab } from "../keywords/keywords-tabs";
import { LaunchTab, VocPositioningTab, DefinitionTab, ChecklistTab } from "../product-reports/product-report-tabs";
import { TrafficTab } from "../traffic/traffic-tab";
import { KeywordCompareLibraryTab, TrafficPromoLibraryTab, ChecklistLibraryTab, ProjectsLibraryTab } from "../projects/project-library-tabs";

export function WorkspaceView({ controller }: { controller: WorkspaceController }) {
  const { flyoutOpen, publicationConvergenceNotice, authSession, market, products, activeLeaf, activeTab, openFlyout, toggleFlyout } = controller;
  return <main className={`app-shell${flyoutOpen ? " flyout-open" : ""}`}>
    {publicationConvergenceNotice ? <div role="status">{publicationConvergenceNotice}</div> : null}
    <WorkspaceSidebar {...controller} />

    <section className="workspace">
      <WorkspaceTopbar {...controller} />
      <ConcurrencyAdminPanel user={authSession.user} />
      <div className="comparison-context"><span>目标市场 <b>{markets[market].label} {markets[market].short}</b></span><span>竞品数量 <b>{products.length} / 10</b></span><span>对比模式 <b>多 ASIN 同屏</b></span><SourceBadge>卖家精灵更新 2026-08-03</SourceBadge></div>

      {activeLeaf.parent ? (
        <div className="voc-tertiary-bar" data-nav-dim={activeTab} aria-label={`${activeLeaf.parent} 当前位置`}>
          <div className="voc-tertiary-crumb">
            <button
              type="button"
              className="voc-tertiary-open"
              onMouseEnter={() => {
                const groupId = groupIdForTab(activeTab);
                if (groupId) {
                  const trigger = document.querySelector<HTMLElement>(`.nav-group-trigger[data-dim="${groupId}"]`);
                  openFlyout(groupId, trigger);
                }
              }}
              onClick={() => {
                const groupId = groupIdForTab(activeTab);
                if (groupId) {
                  const trigger = document.querySelector<HTMLElement>(`.nav-group-trigger[data-dim="${groupId}"]`);
                  toggleFlyout(groupId, trigger);
                }
              }}
            >
              {activeLeaf.parent}
            </button>
            <i>/</i>
            <b>{activeLeaf.label}</b>
          </div>
        </div>
      ) : null}


      {activeTab === "overview" && <OverviewTab {...controller} />}

      {activeTab === "overview-images" && (
        <ListingTab {...controller} />
      )}

      {activeTab === "voc" && <VocTab {...controller} />}

      {activeTab === "keywords" && <KeywordsTab {...controller} />}

      {activeTab === "keyword-insight" && <KeywordInsightTab {...controller} />}

      {activeTab === "launch" && <LaunchTab {...controller} />}

      {activeTab === "voc-positioning" && <VocPositioningTab {...controller} />}

      {activeTab === "definition" && <DefinitionTab {...controller} />}

      {activeTab === "checklist" && <ChecklistTab {...controller} />}

      {activeTab === "traffic" && <TrafficTab {...controller} />}

      {activeTab === "keyword-compare" && <KeywordCompareLibraryTab {...controller} />}

      {activeTab === "traffic-promo" && <TrafficPromoLibraryTab {...controller} />}

      {activeTab === "checklist-library" && <ChecklistLibraryTab {...controller} />}

      {activeTab === "projects" && <ProjectsLibraryTab {...controller} />}
    </section>
    <div className="floating-action-stack">
      <BackToTopButton />
    </div>
  </main>;
}
