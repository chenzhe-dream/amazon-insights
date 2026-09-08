import { runOptionalXydcVariantEnrichment } from "../../scripts/run-asin-sync-job.mjs";
const result = await runOptionalXydcVariantEnrichment({ asins: process.env.XYDC_ASINS.split(","), marketplace: "US" });
process.exitCode = result.succeeded ? 0 : 1;
