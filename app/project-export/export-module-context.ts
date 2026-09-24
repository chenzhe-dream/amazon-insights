import type { CurrentProjectDisplayVersion } from "../lib/project-display-version-browser";

/** Authorized project scope plus the already frozen published report, when available. */
export type ExportModuleContext = Readonly<{
  projectId: string;
  organizationId: string;
  marketplace: string;
  asins: readonly string[];
  sourceAsins: readonly string[];
  currentRunId: string | null;
  /** Per preparation only; shares fully validated reads across related modules. */
  sharedReads?: Map<string, Promise<unknown>>;
  version: CurrentProjectDisplayVersion | null;
  capturedAt: string;
}>;

export type ExportModuleRead = (path: string, init?: RequestInit) => Promise<Response>;
