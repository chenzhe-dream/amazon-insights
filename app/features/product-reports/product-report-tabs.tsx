"use client";

import { vocRunIdFromSearch } from "../../lib/voc-run-browser";
import { ProductLaunchRecommendationSection } from "./product-launch-recommendation";
import { VocPositioningSection } from "../voc/voc-positioning-section";
import { VocEvidenceDefinition } from "../voc/voc-evidence-definition";
import { LaunchChecklistSection } from "./launch-checklist-section";
import { replaceAppUrl } from "../projects/workspace-navigation";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type LaunchTabProps = Pick<WorkspaceController, "products" | "productLaunchSources">;

export function LaunchTab({ products, productLaunchSources }: LaunchTabProps) {
  return <div className="page-content compare-page">
        <ProductLaunchRecommendationSection products={products} sources={productLaunchSources} />
      </div>;
}

type VocPositioningTabProps = Pick<WorkspaceController, "products" | "productLaunchSources">;

export function VocPositioningTab({ products, productLaunchSources }: VocPositioningTabProps) {
  return <div className="page-content compare-page">
        <VocPositioningSection products={products} sources={productLaunchSources} />
      </div>;
}

type DefinitionTabProps = Pick<WorkspaceController, "runtimeSessionKey" | "currentProjectId" | "baseSyncRunId" | "market" | "activeAsins" | "authSession" | "products" | "productLaunchSources" | "appSearch" | "manualVocByAsin" | "workspaceReady">;

export function DefinitionTab({ runtimeSessionKey, currentProjectId, baseSyncRunId, market, activeAsins, authSession, products, productLaunchSources, appSearch, manualVocByAsin, workspaceReady }: DefinitionTabProps) {
  return <div className="page-content compare-page">
        <VocEvidenceDefinition
          key={`${runtimeSessionKey}:${currentProjectId}:${baseSyncRunId}:${market}:${activeAsins.join(",")}`}
          projectId={currentProjectId} baseSyncRunId={baseSyncRunId}
          sessionKey={runtimeSessionKey} organizationId={authSession.user.organizationId}
          marketplace={market} asins={activeAsins} products={products} sources={productLaunchSources}
          initialRunId={vocRunIdFromSearch(appSearch)} initialHistoryRunId={new URLSearchParams(appSearch).get("vocHistory")} initialSelectedAsins={new URLSearchParams(appSearch).get("vocAsins")?.split(",")} refreshToken={JSON.stringify(manualVocByAsin)}
          enabled={!authSession.logoutPending && workspaceReady}
          onRunStarted={(runId, selectedAsins, previousRunId) => {
            const params = new URLSearchParams(window.location.search);
            params.set("vocRun", runId);
            if (previousRunId) params.set("vocHistory", previousRunId);
            params.set("vocAsins", selectedAsins.join(","));
            replaceAppUrl(params);
          }}
        />
      </div>;
}

type ChecklistTabProps = Pick<WorkspaceController, "productLaunchSources" | "products" | "saveChecklistProject" | "savingChecklist" | "activeAsins" | "tabHref" | "message">;

export function ChecklistTab({ productLaunchSources, products, saveChecklistProject, savingChecklist, activeAsins, tabHref, message }: ChecklistTabProps) {
  return <div className="page-content compare-page">
        <LaunchChecklistSection
          sources={productLaunchSources}
          products={products.map(p => ({
            asin: p.asin,
            brand: p.brand,
            title: p.title,
            price: p.price,
            sales: p.sales,
            rating: p.rating,
            reviews: p.reviews,
            launch: p.launch,
            subRankCategory: p.subRankCategory,
            rankCategory: p.rankCategory,
          }))}
          onSaveToLibrary={() => void saveChecklistProject()}
          savingToLibrary={savingChecklist}
          canSaveToLibrary={activeAsins.length >= 3}
          libraryHref={tabHref("checklist-library")}
          libraryMessage={
            message.includes("项目确认清单") || message.includes("立项确认清单") ? message : null
          }
        />
      </div>;
}
