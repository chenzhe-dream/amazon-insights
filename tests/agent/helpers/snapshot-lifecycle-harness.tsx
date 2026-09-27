import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectExportDialog } from "../../../app/project-export/project-export-dialog";
import type { AnalysisProject } from "../../../app/project-library-panel";
import { exportOrganizationId, exportProjectFixture, exportSessionIdentity } from "./project-export-fixture";
import type { ModuleKey } from "../../../shared/module-visibility-contracts";
import "../../../app/globals.css";
import "../../../app/warm-theme.css";
import "../../../app/comparison-layout.css";

const first = exportProjectFixture();
const second = { ...first, id: "10000000-0000-4000-8000-000000000002", name: "第二个灯具项目" };
function Harness() {
  const [open, setOpen] = useState(true);
  const [project, setProject] = useState<AnalysisProject>(first);
  const [session, setSession] = useState(exportSessionIdentity);
  const [visibleModules, setVisibleModules] = useState<readonly ModuleKey[]>(new URLSearchParams(location.search).has("voc")
    ? ["overview", "voc"] : ["overview"]);
  return <>
    <button onClick={() => setOpen(true)}>打开导出</button>
    <button onClick={() => setProject(value => value.id === first.id ? second : first)}>切换项目</button>
    <button onClick={() => setSession(value => value === exportSessionIdentity ? "t".repeat(43) : exportSessionIdentity)}>切换会话</button>
    <button onClick={() => setVisibleModules(["overview"])}>撤销 VOC 权限</button>
    {open && <ProjectExportDialog project={project} visibleModules={visibleModules}
      identity={{sessionIdentity:session,organizationId:exportOrganizationId}}
      onClose={() => setOpen(false)} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
