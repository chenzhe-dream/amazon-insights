import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyGeneratedDataRecovery,
  planGeneratedDataRecovery,
} from "./lib/generated-data-recovery.mjs";

export const PRE_SWITCH_BACKUP_ROOT = "C:\\Users\\EDY\\Amazon-Product-Opportunity-Insights.runtime\\backups\\pre-switch-20260901-123942574";
export const RECOVERY_TARGET_ASINS = Object.freeze([
  "B0C4DGFFCM",
  "B086ZLGLV3",
  "B0CBV5DC7Y",
  "B095NXXP8C",
  "B0CDW797MM",
  "B0DJ7225F3",
]);
export const CANONICAL_SHELF_LIGHT_ASINS = Object.freeze([
  "B08Z36X6B4",
  "B0D77D5WKD",
  "B0BVFX154J",
  "B09F9B3BCY",
  "B01NBPHPYF",
  "B0FSS6C79Z",
]);

function optionValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function runRecovery(argv = process.argv.slice(2), { log = console.log } = {}) {
  const canonicalRoot = path.resolve(optionValue(argv, "--canonical-root", process.cwd()));
  const backupRoot = path.resolve(optionValue(argv, "--backup-root", PRE_SWITCH_BACKUP_ROOT));
  const manifestPath = path.resolve(optionValue(
    argv,
    "--manifest",
    path.join(canonicalRoot, "docs", "recovery", "pre-switch-20260901-six-lighting-results.json"),
  ));
  const plan = planGeneratedDataRecovery({
    backupRoot,
    canonicalRoot,
    targetAsins: RECOVERY_TARGET_ASINS,
    baselineAsins: CANONICAL_SHELF_LIGHT_ASINS,
  });
  const application = argv.includes("--apply")
    ? applyGeneratedDataRecovery(plan, { manifestPath })
    : { alreadyApplied: false, manifest: plan.manifest };
  const mode = !argv.includes("--apply")
    ? "dry-run"
    : application.alreadyApplied
      ? "already-applied"
      : application.repairedDrift
        ? "repaired-drift"
        : "applied";
  log(JSON.stringify({ mode, manifestPath, ...application.manifest }, null, 2));
  return plan;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runRecovery();
