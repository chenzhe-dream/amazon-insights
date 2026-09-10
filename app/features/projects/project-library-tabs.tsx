"use client";

import { UrlResumableAsinSyncFunnel } from "../sync/asin-sync-funnel";
import { ProjectLibraryPage } from "./project-library-panel";
import { inferAmazonMajorCategory } from "../../amazon-major-categories";
import { buildProjectLoadHref } from "./workspace-navigation";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type KeywordCompareLibraryTabProps = Pick<WorkspaceController, "syncAsins" | "syncResume" | "activeAsins" | "market" | "refreshRuntimeAfterSync" | "setRefreshingProjectId" | "setSyncAsins" | "inputs" | "currentProjectId" | "products" | "refreshingProjectId" | "searchParams" | "applyProject" | "setMessage" | "handleKeywordCompareLibraryTabOnRefreshKeywords">;

export function KeywordCompareLibraryTab({ syncAsins, syncResume, activeAsins, market, refreshRuntimeAfterSync, setRefreshingProjectId, setSyncAsins, inputs, currentProjectId, products, refreshingProjectId, searchParams, applyProject, setMessage, handleKeywordCompareLibraryTabOnRefreshKeywords }: KeywordCompareLibraryTabProps) {
  return <div className="page-content compare-page">
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "keywords"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("关键词相关数据已刷新");
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="keyword-compare"
          title="流量词对比"
          description="收藏从「竞品关键词分析」保存的流量词对比项目。打开后可刷新词数据，或编辑追加新的 ASIN。"
          saveLabel="保存为流量词对比项目"
          loadLabel="打开对比"
          emptyHint="还没有流量词对比项目。请先到「关键词调研 · 竞品关键词分析」点击「保存到流量词对比」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "keywords")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开流量词对比「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新流量词对比「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={handleKeywordCompareLibraryTabOnRefreshKeywords}
        />
      </div>;
}

type TrafficPromoLibraryTabProps = Pick<WorkspaceController, "syncAsins" | "syncResume" | "activeAsins" | "market" | "refreshRuntimeAfterSync" | "setRefreshingProjectId" | "setSyncAsins" | "inputs" | "currentProjectId" | "products" | "refreshingProjectId" | "searchParams" | "applyProject" | "setMessage" | "handleTrafficPromoLibraryTabOnRefreshKeywords">;

export function TrafficPromoLibraryTab({ syncAsins, syncResume, activeAsins, market, refreshRuntimeAfterSync, setRefreshingProjectId, setSyncAsins, inputs, currentProjectId, products, refreshingProjectId, searchParams, applyProject, setMessage, handleTrafficPromoLibraryTabOnRefreshKeywords }: TrafficPromoLibraryTabProps) {
  return <div className="page-content compare-page">
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "traffic"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("流量相关数据已刷新");
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="traffic-promo"
          title="竞品推广能力分析"
          description="收藏从「竞品流量分析」保存的推广能力分析项目。打开后进入流量结构与推广结论页。"
          saveLabel="保存为推广能力分析项目"
          loadLabel="打开分析"
          emptyHint="还没有推广能力分析项目。请先到「竞品流量分析」点击「保存到推广能力分析」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "traffic")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开推广能力分析「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新推广能力分析「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={handleTrafficPromoLibraryTabOnRefreshKeywords}
        />
      </div>;
}

type ChecklistLibraryTabProps = Pick<WorkspaceController, "syncAsins" | "syncResume" | "activeAsins" | "market" | "refreshRuntimeAfterSync" | "setRefreshingProjectId" | "setSyncAsins" | "inputs" | "currentProjectId" | "products" | "refreshingProjectId" | "searchParams" | "applyProject" | "setMessage" | "handleChecklistLibraryTabOnRefreshKeywords">;

export function ChecklistLibraryTab({ syncAsins, syncResume, activeAsins, market, refreshRuntimeAfterSync, setRefreshingProjectId, setSyncAsins, inputs, currentProjectId, products, refreshingProjectId, searchParams, applyProject, setMessage, handleChecklistLibraryTabOnRefreshKeywords }: ChecklistLibraryTabProps) {
  return <div className="page-content compare-page">
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "reviews", "alexa_voc"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("竞品与 VOC 相关数据已刷新");
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="checklist"
          title="项目确认清单"
          description="收藏从「立项前确认清单」保存的项目。打开后进入清单页，可刷新竞品与 VOC 数据，或编辑追加新 ASIN。"
          saveLabel="保存为项目确认清单"
          loadLabel="打开清单"
          emptyHint="还没有项目确认清单。请先到「立项前确认清单」点击「保存到项目确认清单」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "checklist")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开立项确认清单「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新项目确认清单「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={handleChecklistLibraryTabOnRefreshKeywords}
        />
      </div>;
}

type ProjectsLibraryTabProps = Pick<WorkspaceController, "runtimeSessionKey" | "projectFavorites" | "authSession" | "market" | "inputs" | "currentProjectId" | "products" | "searchParams" | "applyProject" | "setMessage" | "handleProjectsLibraryTabOnProjectDeleted">;

export function ProjectsLibraryTab({ runtimeSessionKey, projectFavorites, authSession, market, inputs, currentProjectId, products, searchParams, applyProject, setMessage, handleProjectsLibraryTabOnProjectDeleted }: ProjectsLibraryTabProps) {
  return <div className="page-content compare-page">
        <ProjectLibraryPage
          kind="analysis"
          key={runtimeSessionKey}
          favorites={projectFavorites}
          canDeleteProjects={authSession.user.role === "admin" && !authSession.logoutPending}
          onProjectDeleted={handleProjectsLibraryTabOnProjectDeleted}
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams)}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已加载项目「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false, replace: true });
          }}
        />
      </div>;
}
