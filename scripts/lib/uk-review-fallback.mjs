import { hasCompleteReviewRecord } from "./sync-cache.mjs";
const reviewFallbackMarkets = new Set(["US", "UK", "DE", "CA"]);

export function reviewFallbackEnabled(marketplace, env = process.env) {
  if (!reviewFallbackMarkets.has(marketplace)) return false;
  if (env.AGENT_SELLERSPRITE_REVIEW_FALLBACK != null) return env.AGENT_SELLERSPRITE_REVIEW_FALLBACK === "1";
  return marketplace === "UK" && env.AGENT_UK_SELLERSPRITE_REVIEW_FALLBACK === "1";
}

export function sellerSpriteReviewFallbackEnv(asins, marketplace) {
  if (!reviewFallbackMarkets.has(marketplace)) throw new TypeError("Unsupported review fallback marketplace");
  return { SELLERSPRITE_ASINS: asins.join(","), SELLERSPRITE_MARKETPLACE: marketplace, AGENT_SYNC_MARKETPLACE: marketplace };
}

export function sellerSpriteReviewMarkets(env = process.env) {
  const project = env.AGENT_SYNC_MARKETPLACE ?? env.SELLERSPRITE_MARKETPLACE ?? "US";
  return { project, provider: project === "GB" ? "UK" : project };
}

function exactRecord(record, asin, marketplace) {
  return record?.asin === asin && record?.marketplace === marketplace;
}

export function isValidSorftimeEmptyReview(record, asin, marketplace) {
  return exactRecord(record, asin, marketplace) &&
    record.status === "pending" && record.terminalReason === "valid-empty" &&
    record.sampledReviews === 0 && record.mentionTopics === 0 &&
    Array.isArray(record.blocks) && record.blocks.every(block => Array.isArray(block?.rows) && block.rows.length === 0) &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.fetchedAt ?? "") &&
    Number.isFinite(Date.parse(record.fetchedAt));
}

export function selectUkReviewFallbackAsins(asins, sorftimeByAsin, { marketplace, enabled, attempts = [] }) {
  if (marketplace !== "UK" || enabled !== true) return [];
  return selectReviewFallbackAsins(asins, sorftimeByAsin, { marketplace, enabled, attempts });
}

export function selectReviewFallbackAsins(asins, sorftimeByAsin, { marketplace, enabled, attempts = [] }) {
  if (!reviewFallbackMarkets.has(marketplace) || enabled !== true) return [];
  const failedAsins = new Set();
  for (const attempt of attempts) {
    const diagnostics = attempt?.diagnostics ?? [];
    // Only attributed consumer/schema failures can be isolated to a sibling.
    // Quota, auth, transport, breaker and unclassified failures remain closed.
    if (attempt?.succeeded !== true && !diagnostics.length) return [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.failureKind !== "schema" || diagnostic.causeCode !== "MCP_SCHEMA" || !asins.includes(diagnostic.asin)) return [];
      failedAsins.add(diagnostic.asin);
    }
  }
  return [...new Set(asins)].filter(asin =>
    !failedAsins.has(asin) && /^[A-Z0-9]{10}$/.test(asin) && isValidSorftimeEmptyReview(sorftimeByAsin?.[asin], asin, marketplace));
}

export function selectReviewEvidence(asin, marketplace, sorftime, sellerSprite) {
  if (exactRecord(sorftime, asin, marketplace) && hasCompleteReviewRecord(sorftime)) {
    return sorftime;
  }
  if (reviewFallbackMarkets.has(marketplace) && isValidSorftimeEmptyReview(sorftime, asin, marketplace) &&
    exactRecord(sellerSprite, asin, marketplace) && hasCompleteReviewRecord(sellerSprite)) {
    return { ...sellerSprite, sourceProvider: "sellerSprite" };
  }
  return null;
}

// Observations may be displayed without satisfying theme-analysis readiness.
// Keep this separate from selectReviewEvidence, which drives task completion.
export function selectReviewObservation(asin, marketplace, sorftime, sellerSprite, updatedAt) {
  const valid = record => exactRecord(record, asin, marketplace) &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.fetchedAt ?? '') &&
    Number.isFinite(Date.parse(record.fetchedAt)) && Date.parse(record.fetchedAt) <= Date.parse(updatedAt) &&
    Number.isInteger(record.sampledReviews) && record.sampledReviews >= 0 &&
    Array.isArray(record.blocks) && record.blocks.every(block => Array.isArray(block?.rows)) &&
    ((record.status === 'ready' && (record.sampledReviews > 0 || record.mentionTopics > 0)) ||
      isValidSorftimeEmptyReview(record, asin, marketplace));
  const selected = selectReviewEvidence(asin, marketplace, sorftime, sellerSprite);
  if (selected && valid(selected)) return selected;
  if (reviewFallbackMarkets.has(marketplace) && valid(sorftime) && isValidSorftimeEmptyReview(sorftime, asin, marketplace) && valid(sellerSprite)) {
    return {...sellerSprite, sourceProvider: 'sellerSprite'};
  }
  return valid(sorftime) ? sorftime : null;
}
