import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Source-level guards still inspect the production composition after it is split.
// Do not substitute fixtures or remove assertions when moving production code.
export function readWorkspaceSource() {
  const directory = path.join(root, "app/features/workspace");
  function filesIn(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? filesIn(file) : /\.tsx?$/.test(entry.name) ? [file] : [];
    });
  }
  const files = filesIn(directory).sort((a, b) => {
    const priority = file => file.endsWith("use-workspace-controller.ts") ? 0 : 1;
    return priority(a) - priority(b) || a.localeCompare(b);
  });
  const presentation = [
    "catalog/overview-tab.tsx", "listing/listing-tab.tsx", "voc/voc-tab.tsx",
    "keywords/keywords-tabs.tsx", "product-reports/product-report-tabs.tsx",
    "traffic/traffic-tab.tsx", "projects/project-library-tabs.tsx",
    "shell/workspace-sidebar.tsx", "shell/workspace-topbar.tsx",
  ].map(file => path.join(root, "app/features", file));
  return [path.join(root, "app/page.tsx"), ...files, ...presentation]
    .map(file => readFileSync(file, "utf8")).join("\n");
}
