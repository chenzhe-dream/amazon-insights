import { callSifTool } from "./sif-mcp-client.mjs";
import { buildKeywordEnrichment, normalizeKeywordKey } from "./sif-keyword-transform.mjs";

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

export async function enrichKeywords(keywords, marketplace, fetchedAt, existing = {}) {
  const enrichment = { ...existing };
  const pending = keywords.filter(keyword => {
    const key = normalizeKeywordKey(keyword);
    const record = enrichment[key];
    return !record || record.status !== "ready";
  });

  if (!pending.length) {
    console.log(`[enrich] ${keywords.length} keywords · all cached`);
    return enrichment;
  }

  console.log(`[enrich] fetching ${pending.length} keywords (${keywords.length} total)`);

  for (const batch of chunk(pending, 10)) {
    process.stdout.write(`[sif] history ${batch.length} keywords ... `);
    try {
      const payload = await callSifTool("market_get_keyword_history", {
        keywords: batch,
        country: marketplace,
        granularity: "month",
      });
      const historyMap = new Map((payload?.keywords ?? []).map(item => [normalizeKeywordKey(item.keyword), item]));
      console.log("ok");
      for (const keyword of batch) {
        const key = normalizeKeywordKey(keyword);
        const historyEntry = historyMap.get(key);
        enrichment[key] = {
          keyword,
          fetchedAt,
          status: historyEntry ? "ready" : "partial",
          ...buildKeywordEnrichment(keyword, historyEntry, null),
        };
      }
    } catch (error) {
      console.log(`error (${error instanceof Error ? error.message : String(error)})`);
      for (const keyword of batch) {
        const key = normalizeKeywordKey(keyword);
        if (!enrichment[key]) {
          enrichment[key] = {
            keyword,
            fetchedAt,
            status: "error",
            statusMessage: error instanceof Error ? error.message : String(error),
            searchTrend: [],
            bidLow: null,
            bidMedian: null,
            bidHigh: null,
            clickConversionRate: null,
            top3ClickShare: null,
            top3ConversionShare: null,
          };
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  for (const batch of chunk(pending, 20)) {
    process.stdout.write(`[sif] promotion ${batch.length} keywords ... `);
    try {
      const payload = await callSifTool("market_assess_keyword_promotion", {
        keywords: batch,
        country: marketplace,
      });
      const promotionMap = new Map((payload?.assessments ?? []).map(item => [normalizeKeywordKey(item.keyword), item]));
      console.log("ok");
      for (const keyword of batch) {
        const key = normalizeKeywordKey(keyword);
        const promotionEntry = promotionMap.get(key);
        const current = enrichment[key] ?? { keyword, fetchedAt, status: "partial", searchTrend: [] };
        const merged = buildKeywordEnrichment(keyword, { latest: {} }, promotionEntry);
        enrichment[key] = {
          ...current,
          keyword,
          fetchedAt,
          status: current.status === "error" && !promotionEntry ? "error" : "ready",
          bidLow: merged.bidLow ?? current.bidLow ?? null,
          bidMedian: merged.bidMedian ?? current.bidMedian ?? null,
          bidHigh: merged.bidHigh ?? current.bidHigh ?? null,
          clickConversionRate: merged.clickConversionRate ?? current.clickConversionRate ?? null,
          top3ClickShare: current.top3ClickShare ?? merged.top3ClickShare,
          top3ConversionShare: current.top3ConversionShare ?? merged.top3ConversionShare,
        };
      }
    } catch (error) {
      console.log(`error (${error instanceof Error ? error.message : String(error)})`);
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  return enrichment;
}

export function collectUniqueKeywords(records) {
  const set = new Set();
  for (const record of Object.values(records)) {
    if (record?.status !== "ready") continue;
    for (const row of record.keywords ?? []) {
      if (row.keyword) set.add(row.keyword);
    }
  }
  return [...set];
}
