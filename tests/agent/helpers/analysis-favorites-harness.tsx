import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectLibraryPage } from "../../../app/project-library-panel";
import { useAnalysisProjectFavorites } from "../../../app/use-analysis-project-favorites";
import { AnalysisProjectFavoriteButton } from "../../../app/analysis-project-favorite-button";
import "../../../app/globals.css";
import "../../../app/warm-theme.css";
const id = "10000000-0000-4000-8000-000000000001";
function Harness() {
  const [scope, setScope] = useState("first-session");
  const favorites = useAnalysisProjectFavorites(scope);
  const kind = new URLSearchParams(location.search).get("kind") === "traffic-promo" ? "traffic-promo" : "analysis";
  return <><button onClick={() => setScope("second-session")}>切换会话</button>
    <AnalysisProjectFavoriteButton projectId={id} favorites={favorites} />
    <ProjectLibraryPage key={scope} kind={kind} market="US" currentProjectId={id}
      draftAsins={["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"]} favorites={favorites}
      buildLoadHref={project => `/p/${project.slug}`} /></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
