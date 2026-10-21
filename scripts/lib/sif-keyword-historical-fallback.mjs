import { buildSifKeywordAnalysis } from "./sif-keyword-transform.mjs";
import { previousCompleteMonthWindow, SIF_KEYWORD_QUERY_WINDOW } from "./sif-keyword-sync-config.mjs";
import { sourceFetchedDate } from "./sorftime-source-policy.mjs";

/** One bounded historical query, only after a strict-valid empty current result. */
export async function collectSifKeywordWithPreviousMonth({ asin, marketplace, fetchedAt, topN = 50,
  enabled = false, now = new Date(), call }) {
  const invoke = async window => {
    const payload = await call("market_get_asin_keyword_signals", { asin, country: marketplace, ...window, topN });
    return buildSifKeywordAnalysis(asin, marketplace, payload, sourceFetchedDate([payload], fetchedAt), window);
  };
  const current = await invoke(SIF_KEYWORD_QUERY_WINDOW);
  if (!enabled || marketplace !== "UK" || current.status !== "empty" || current.terminalReason !== "valid-empty") return current;
  const window = previousCompleteMonthWindow(now);
  const currentEmpty = { queryWindow: SIF_KEYWORD_QUERY_WINDOW, observedAt: fetchedAt, terminalReason: "valid-empty" };
  try {
    const historical = await invoke(window);
    if (historical.status === "ready") return { ...historical, currentEmpty };
    if (historical.status === "empty") return { ...current, historicalEmpty: { queryWindow: window, observedAt: fetchedAt, terminalReason: "valid-empty" } };
    return { ...current, historicalAttempt: { queryWindow: window, outcome: "schema-error" } };
  } catch (error) {
    return { ...current, historicalAttempt: { queryWindow: window, outcome: "error" },
      statusMessage: `${current.statusMessage}; 上月查询失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
