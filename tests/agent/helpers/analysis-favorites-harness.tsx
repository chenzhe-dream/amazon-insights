import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectLibraryPage } from "../../../app/features/projects/project-library-panel";
import { useAnalysisProjectFavorites } from "../../../app/features/projects/use-analysis-project-favorites";
import { AnalysisProjectFavoriteButton } from "../../../app/features/projects/analysis-project-favorite-button";
import "../../../app/globals.css";
import "../../../app/warm-theme.css";
const id = "10000000-0000-4000-8000-000000000001";
function Harness() {
  const [scope, setScope] = useState("first-session");
  const [currentId, setCurrentId] = useState<string | null>(new URLSearchParams(location.search).get("other") === "true" ? "other-project" : id);
  const favorites = useAnalysisProjectFavorites(scope);
  const kind = new URLSearchParams(location.search).get("kind") === "traffic-promo" ? "traffic-promo" : "analysis";
  return <><button onClick={() => setScope("second-session")}>切换会话</button>
    <output aria-label="当前项目">{currentId ?? "无"}</output>
    <AnalysisProjectFavoriteButton projectId={currentId} favorites={favorites} />
    <ProjectLibraryPage key={scope} kind={kind} market="US" currentProjectId={currentId}
      canDeleteProjects={new URLSearchParams(location.search).get("admin") === "true"}
      onProjectDeleted={deletedId => { if (deletedId === currentId) setCurrentId(null); }}
      draftAsins={["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"]} favorites={favorites}
      buildLoadHref={project => `/p/${project.slug}`} /></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
