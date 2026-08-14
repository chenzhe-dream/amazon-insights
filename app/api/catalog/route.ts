import fs from "node:fs";
import path from "node:path";
import { getProjectRoot } from "../../../scripts/lib/project-root.mjs";
import { readCachedArrayExport } from "../../../scripts/lib/sync-cache.mjs";

const catalogPath = path.join(getProjectRoot(), "app", "competitor-data.ts");

export async function GET() {
  const items = readCachedArrayExport(catalogPath, "refreshedCatalog");
  const updatedAt = fs.existsSync(catalogPath)
    ? new Date(fs.statSync(catalogPath).mtimeMs).toISOString().slice(0, 10)
    : null;
  return Response.json({ items, updatedAt, count: items.length });
}
