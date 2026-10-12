import path from "node:path";
import { getXydcOrderWindow, summarizeXydcOrders } from "../../shared/xydc-order-summary";
import { readXydcVariantFamily } from "./xydc-variant-cache";
import { readXydcOrderDisplaySnapshot } from "./xydc-order-display-cache";
import { readXydcOrderSnapshot } from "./xydc-order-cache";
import { resolveRuntimeRoots } from "./runtime-roots.mjs";

type RepairReadOptions = { dataRoot?: string; now?: Date; codeRoot?: string; env?: NodeJS.ProcessEnv };
type RepairStatus = "ready" | "timeout" | "connector-failed" | "upstream-empty";
function incompleteStatus(reasons: readonly (string | null | undefined)[]): RepairStatus {
  if (reasons.includes("TIMEOUT")) return "timeout";
  if (reasons.some(reason => reason && !["NOT_FOUND", "PARTIAL_DATA", "PARTIAL_CHILD_INFO"].includes(reason))) return "connector-failed";
  return "upstream-empty";
}
export async function asinsNeedingXydcRepair(asins: readonly string[], country: string, options: RepairReadOptions = {}) {
  return (await readXydcRepairStatuses(asins, country, options)).filter(item => item.status !== "ready").map(item => item.asin);
}
// Preserve the existing compact API for consumers; detailed results are independently available.
export async function readXydcRepairStatuses(asins: readonly string[], country: string, options: RepairReadOptions = {}) {
  return (await readXydcRepairDetails(asins, country, options)).map(({ asin, status }) => ({ asin, status }));
}
export async function readXydcRepairDetails(asins: readonly string[], country: string,
  { dataRoot: explicitDataRoot, now = new Date(), codeRoot = path.resolve(import.meta.dirname, "../.."), env = process.env }: RepairReadOptions = {}) {
  const dataRoot = explicitDataRoot ?? resolveRuntimeRoots({ codeRoot, env, formal: Boolean(env.AGENT_FORMAL_WORKTREE_ROOT), commit: undefined }).dataRoot;
  if (!path.isAbsolute(dataRoot)) throw new Error("AGENT_DATA_ROOT must be absolute");
  const window = getXydcOrderWindow(now);
  const statuses = [];
  for (const asin of new Set(asins)) {
    const family = await readXydcVariantFamily(dataRoot, country, asin);
    const relationship: RepairStatus = family?.children.length ? "ready" : incompleteStatus([family?.reasonCode]);
    const missingFields = (family?.children ?? []).flatMap(child => {
      const fields = (["title", "imageUrl", "price", "currency", "stars", "productPageRatings"] as const).filter(field => child[field] === null);
      return fields.length ? [{ asin: child.asin, fields }] : [];
    });
    const coreDetails: RepairStatus = relationship === "ready" && !missingFields.some(child => child.fields.some(field => !["stars", "productPageRatings"].includes(field))) ? "ready" : incompleteStatus([family?.reasonCode]);
    const ratings: RepairStatus = relationship === "ready" && !missingFields.some(child => child.fields.some(field => ["stars", "productPageRatings"].includes(field))) ? "ready" : incompleteStatus([family?.reasonCode]);
    const snapshot = family?.children.length ? readXydcOrderDisplaySnapshot(dataRoot, family, window, now) : null;
    const current = family?.children.length ? await readXydcOrderSnapshot(dataRoot, family, window) : null;
    const orders: RepairStatus = snapshot && snapshot.window.startMonth === window.startMonth && snapshot.window.endMonth === window.endMonth && summarizeXydcOrders(snapshot).complete
      ? "ready" : incompleteStatus([current?.reasonCode, ...(current?.children.map(child => child.reasonCode) ?? []), ...(!family?.children.length ? [family?.reasonCode] : [])]);
    // Original provider status stays authoritative for aggregate completeness.
    const status: RepairStatus = family?.status === "ready" && family.children.length && family.children.every(child => child.infoStatus === "ready") && orders === "ready"
      ? "ready" : incompleteStatus([family?.reasonCode, current?.reasonCode, ...(current?.children.map(child => child.reasonCode) ?? [])]);
    statuses.push({ asin, status, relationship, coreDetails, ratings, orders, missingFields });
  }
  return statuses;
}
