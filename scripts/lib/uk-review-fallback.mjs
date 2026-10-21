import { hasCompleteReviewRecord } from "./sync-cache.mjs";
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

export function selectUkReviewFallbackAsins(asins, sorftimeByAsin, { marketplace, enabled }) {
  if (marketplace !== "UK" || enabled !== true) return [];
  return [...new Set(asins)].filter(asin =>
    /^[A-Z0-9]{10}$/.test(asin) && isValidSorftimeEmptyReview(sorftimeByAsin?.[asin], asin, marketplace));
}

export function selectReviewEvidence(asin, marketplace, sorftime, sellerSprite) {
  if (exactRecord(sorftime, asin, marketplace) && hasCompleteReviewRecord(sorftime)) {
    return { ...sorftime, sourceProvider: "sorftime" };
  }
  if (marketplace === "UK" && isValidSorftimeEmptyReview(sorftime, asin, marketplace) &&
    exactRecord(sellerSprite, asin, marketplace) && hasCompleteReviewRecord(sellerSprite)) {
    return { ...sellerSprite, sourceProvider: "sellerSprite" };
  }
  return null;
}
