import type { ExportSectionId } from "./module-catalog";

export type ExportCell = { text: string; imageUrl?: string; href?: string };

export type ExportBlock =
  | { kind: "text"; text: string }
  | { kind: "table"; title: string; columns: readonly string[]; rows: readonly (readonly ExportCell[])[] }
  | { kind: "chart"; title: string; labels: readonly string[]; series: readonly { label: string; values: readonly (number | null)[] }[] };

export type ExportSection = {
  id: ExportSectionId;
  title: string;
  status: "ready" | "missing";
  blocks: readonly ExportBlock[];
};

export type PreparedExportContent = {
  schemaVersion: "1";
  project: { id: string; name: string; marketplace: string; asins: readonly string[] };
  capturedAt: string;
  sourceLabel: string;
  sections: readonly ExportSection[];
};
