import fs from "node:fs";
import path from "node:path";

import { selectXydcOrderDisplaySnapshot } from "../../shared/xydc-order-display";
import { XydcOrderSnapshotSchema, type XydcOrderWindow } from "../../shared/xydc-order-contract";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";
import { xydcOrderCachePath } from "./xydc-order-cache";

function canonicalPath(value: string) {
  return path.normalize(path.resolve(value));
}

export function readXydcOrderDisplaySnapshot(
  dataRoot: string,
  family: XydcVariantFamily,
  window: XydcOrderWindow,
  now: Date,
) {
  let currentPath: string;
  try {
    currentPath = xydcOrderCachePath(dataRoot, family, window);
  } catch {
    return null;
  }
  const directory = path.dirname(currentPath);
  const filenamePattern = new RegExp(`^${family.parentAsin}-\\d{4}-(?:0[1-9]|1[0-2])-\\d{4}-(?:0[1-9]|1[0-2])-[0-9a-f]{20}\\.json$`);
  const paths = new Set<string>([currentPath]);
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && !entry.isSymbolicLink() && filenamePattern.test(entry.name)) {
        paths.add(path.join(directory, entry.name));
      }
    }
  } catch {
    // The current canonical path is still attempted below.
  }

  const candidates = [...paths].flatMap(filePath => {
    try {
      const metadata = fs.lstatSync(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return [];
      const parsed = XydcOrderSnapshotSchema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf8")));
      if (!parsed.success) return [];
      const expectedPath = xydcOrderCachePath(dataRoot, family, parsed.data.window);
      return canonicalPath(filePath) === canonicalPath(expectedPath) ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
  return selectXydcOrderDisplaySnapshot(candidates, family, window, now);
}
