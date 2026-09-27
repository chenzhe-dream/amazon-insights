import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectExportDialog } from "../../../app/project-export/project-export-dialog";
import type { ModuleKey } from "../../../shared/module-visibility-contracts";
import { exportProjectFixture } from "./project-export-fixture";
import "../../../app/globals.css";

function Harness() {
  const [visible, setVisible] = useState<readonly ModuleKey[] | undefined>(undefined);
  return <>
    <button onClick={() => setVisible(["overview", "voc"])}>限制权限</button>
    <ProjectExportDialog project={exportProjectFixture()} visibleModules={visible} onClose={() => {}} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
