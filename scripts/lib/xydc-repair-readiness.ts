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

/** Read-only completeness check using the same identity/window checks as the display. */
export async function asinsNeedingXydcRepair(
  asins: readonly string[],
  country: string,
  options: RepairReadOptions = {},
) {
  return (await readXydcRepairStatuses(asins, country, options)).filter(item => item.status !== "ready").map(item => item.asin);
}

export async function readXydcRepairStatuses(
  asins: readonly string[], country: string,
  { dataRoot: explicitDataRoot, now = new Date(), codeRoot = path.resolve(import.meta.dirname, "../.."), env = process.env }: RepairReadOptions = {},
): Promise<{ asin: string; status: RepairStatus }[]> {
  const dataRoot = explicitDataRoot ?? resolveRuntimeRoots({ codeRoot, env, formal: Boolean(env.AGENT_FORMAL_WORKTREE_ROOT), commit: undefined }).dataRoot;
  if (!path.isAbsolute(dataRoot)) throw new Error("AGENT_DATA_ROOT must be absolute");
  const window = getXydcOrderWindow(now);
  const statuses: { asin: string; status: RepairStatus }[] = [];
  for (const asin of new Set(asins)) {
    const family = await readXydcVariantFamily(dataRoot, country, asin);
    if (!family || family.status !== "ready" || !family.children.length
      || family.children.some(child => child.infoStatus !== "ready")) {
      statuses.push({ asin, status: incompleteStatus([family?.reasonCode]) });
      continue;
    }
    const snapshot = readXydcOrderDisplaySnapshot(dataRoot, family, window, now);
    if (snapshot && snapshot.window.startMonth === window.startMonth && snapshot.window.endMonth === window.endMonth
      && summarizeXydcOrders(snapshot).complete) statuses.push({ asin, status: "ready" });
    else {
      const current = await readXydcOrderSnapshot(dataRoot, family, window);
      statuses.push({ asin, status: incompleteStatus([current?.reasonCode, ...(current?.children.map(child => child.reasonCode) ?? [])]) });
    }
  }
  return statuses;
}
