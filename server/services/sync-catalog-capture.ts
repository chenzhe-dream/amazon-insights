import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { SyncCatalogCapture } from "../db/sync-job-repository";

function parseCatalogArray(source: string): unknown[] {
  const marker = /\bexport\s+const\s+refreshedCatalog\b/g;
  const match = marker.exec(source);
  if (!match) throw new Error("Generated catalog export is missing");
  const assignment = source.indexOf("=", match.index + match[0].length);
  if (assignment < 0) throw new Error("Generated catalog assignment is missing");
  const start = source.indexOf("[", assignment + 1);
  if (start < 0 || source.slice(assignment + 1, start).trim()) {
    throw new Error("Generated catalog array is missing");
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) {
      const parsed: unknown = JSON.parse(source.slice(start, index + 1));
      if (!Array.isArray(parsed)) throw new Error("Generated catalog is not an array");
      return parsed;
    }
  }
  throw new Error("Generated catalog array is incomplete");
}

export async function captureGeneratedSyncCatalog(input: {
  catalogPath: string;
  asins: readonly string[];
  capturedAt: string;
}): Promise<SyncCatalogCapture> {
  const before = await stat(input.catalogPath);
  const bytes = await readFile(input.catalogPath);
  const after = await stat(input.catalogPath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error("Generated catalog changed while it was captured");
  }
  const requested = new Set(input.asins);
  const records = parseCatalogArray(bytes.toString("utf8"));
  const selected = records.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item) && requested.has((item as { asin?: unknown }).asin as string));
  if (new Set(selected.map(item => item.asin)).size !== selected.length) {
    throw new Error("Generated catalog has duplicate requested ASINs");
  }
  return {
    catalog: selected,
    evidence: {
      sourceKind: "generated-file",
      sourceRef: "app/competitor-data.ts#refreshedCatalog",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceUpdatedAt: after.mtime.toISOString(),
      capturedAt: new Date(input.capturedAt).toISOString(),
    },
  };
}
