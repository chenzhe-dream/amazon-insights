import { callXydcTool, withXydcSession, XydcProviderError } from "../../scripts/lib/xydc-mcp-client";
import { syncXydcOrderFamilies } from "../../scripts/lib/xydc-order-sync";
import { fixtureFamily, fixtureNow } from "./xydc-http-fixture";
const mode = process.argv[2];
try {
  if (mode === "collect" || mode === "crash-after-child") await syncXydcOrderFamilies({
    families: [fixtureFamily()], now: fixtureNow, token: process.env.XYDC_FIXTURE_TOKEN!, dataRoot: process.env.XYDC_FIXTURE_DATA_ROOT!,
    onProgress: facts => { if (mode === "crash-after-child" && facts.state === "collecting" && facts.children.some(child => child.state === "ready")) process.exit(0); },
  });
  else if (mode === "empty") await withXydcSession(process.env.XYDC_FIXTURE_TOKEN!, async () => {});
  else await callXydcTool(process.env.XYDC_FIXTURE_TOKEN!, "get_asin_info", {});
  process.stdout.write("completed\n");
} catch (error) {
  if (!(error instanceof XydcProviderError)) throw error;
  process.stdout.write(`${error.reasonCode}\n`);
}
