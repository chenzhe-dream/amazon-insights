import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectLibraryPage } from "../../../app/project-library-panel";
import { useAnalysisProjectFavorites } from "../../../app/use-analysis-project-favorites";
import { AnalysisProjectFavoriteButton } from "../../../app/analysis-project-favorite-button";
import { ModuleKeySchema } from "../../../shared/module-visibility-contracts";
import { exportSessionIdentity, exportOrganizationId } from "./project-export-fixture";
import "../../../app/globals.css";
import "../../../app/warm-theme.css";
import "../../../app/comparison-layout.css";
const id = "10000000-0000-4000-8000-000000000001";
function Harness() {
  const [scope, setScope] = useState("first-session");
  const [segment, setSegment] = useState("");
  const guard = new URLSearchParams(location.search).get("guard") === "true";
  const [currentId, setCurrentId] = useState<string | null>(new URLSearchParams(location.search).get("other") === "true" ? "other-project" : id);
  const favorites = useAnalysisProjectFavorites(scope);
  const kind = new URLSearchParams(location.search).get("kind") === "traffic-promo" ? "traffic-promo" : "analysis";
  return <><button onClick={() => setScope("second-session")}>切换会话</button>
    <output aria-label="当前项目">{currentId ?? "无"}</output>
    {guard && <label>细分名称<input value={segment} onChange={event => setSegment(event.target.value)} /></label>}
    <AnalysisProjectFavoriteButton projectId={currentId} favorites={favorites} beforeFavorite={guard ? async () => {
      if (!segment.trim()) throw new Error("请先填写细分名称，再收藏项目");
      const response = await fetch(`/api/agent/v1/local-data/projects/${currentId}`, { method: "PATCH", body: JSON.stringify({ name: segment.trim() }) });
      if (!response.ok) throw new Error("保存细分名称失败，请重试");
      return true;
    } : undefined} />
    <ProjectLibraryPage key={scope} kind={kind} market="US" currentProjectId={currentId}
      exportIdentity={new URLSearchParams(location.search).get("export") === "true" ? {sessionIdentity:exportSessionIdentity,organizationId:exportOrganizationId}:undefined}
      exportVisibleModules={new URLSearchParams(location.search).has("modules")
        ? new URLSearchParams(location.search).get("modules")!.split(",").filter(Boolean).map(value => ModuleKeySchema.parse(value)) : undefined}
      canDeleteProjects={new URLSearchParams(location.search).get("admin") === "true"}
      onProjectDeleted={deletedId => { if (deletedId === currentId) setCurrentId(null); }}
      draftAsins={["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"]} favorites={favorites}
      buildLoadHref={project => `/p/${project.slug}`} /></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
