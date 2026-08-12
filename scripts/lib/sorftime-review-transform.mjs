import { buildReviewAnalysisFromRecords } from "./review-analysis-aggregate.mjs";
import { localizeReviewBlocks, localizeReviewRow, translateReviewLabel } from "./review-label-zh.mjs";

const blockLabels = {
  consumerProfile: "消费者画像",
  scenarios: "使用场景",
  unmet: "未被满足的需求",
  positives: "好评点",
  negatives: "差评点",
  motives: "购买动机",
};

function humanizeKeyword(keyword) {
  return translateReviewLabel(
    keyword
      .split(/[\s_-]+/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function mentionPct(mention, total) {
  if (!total) return 0;
  return Number(((mention / total) * 100).toFixed(2));
}

function mapReviews(reviews) {
  return (reviews ?? []).map(item => ({
    title: item.title ?? "",
    content: item.content ?? "",
    star: Math.round(item.star_rating ?? item.star ?? 0),
    author: item.author ?? "",
  }));
}

function rowsFromCustomersSay(details, filter, sortKey, limit = 5) {
  const total = details.reduce((sum, item) => sum + item.mention, 0) || 1;
  return [...details]
    .filter(filter)
    .sort((a, b) => b[sortKey] - a[sortKey] || b.mention - a.mention)
    .slice(0, limit)
    .map(item => localizeReviewRow({
      label: humanizeKeyword(item.keyword),
      sharePct: mentionPct(item.mention, total),
      reason: item.content,
    }));
}

export function buildSorftimeReviewAnalysis(asin, marketplace, customersSay, reviews, fetchedAt) {
  const details = customersSay?.details ?? [];
  const mappedReviews = mapReviews(reviews);
  const reviewBlocks = buildReviewAnalysisFromRecords(asin, marketplace, mappedReviews, fetchedAt);

  const reviewBlockMap = Object.fromEntries(reviewBlocks.blocks.map(block => [block.key, block]));

  const blocks = [
    {
      key: "consumerProfile",
      label: blockLabels.consumerProfile,
      rows: reviewBlockMap.consumerProfile?.rows?.length
        ? reviewBlockMap.consumerProfile.rows
        : rowsFromCustomersSay(
            details,
            item => /age|toddler|kid|child|grand/i.test(item.keyword + item.content),
            "mention"
          ),
    },
    {
      key: "scenarios",
      label: blockLabels.scenarios,
      rows: reviewBlockMap.scenarios?.rows?.length
        ? reviewBlockMap.scenarios.rows
        : rowsFromCustomersSay(
            details,
            item => /gift|outdoor|travel|birthday|fun|maneuver/i.test(item.keyword + item.content),
            "mention"
          ),
    },
    {
      key: "unmet",
      label: blockLabels.unmet,
      rows: rowsFromCustomersSay(
        details,
        item =>
          item.negative > item.positive ||
          /mixed|report|issue|break|don't|doesn't|difficult|poor|fail/i.test(item.content),
        "negative"
      ),
    },
    {
      key: "positives",
      label: blockLabels.positives,
      rows: rowsFromCustomersSay(
        details,
        item => item.positive > item.negative,
        "positive"
      ),
    },
    {
      key: "negatives",
      label: blockLabels.negatives,
      rows: rowsFromCustomersSay(
        details,
        item => item.negative >= Math.max(12, item.positive * 0.35),
        "negative"
      ),
    },
    {
      key: "motives",
      label: blockLabels.motives,
      rows: reviewBlockMap.motives?.rows?.length
        ? reviewBlockMap.motives.rows
        : rowsFromCustomersSay(
            details,
            item => /value|gift|quality|light|adjust|ease|fun|age|durability|sturd/i.test(item.keyword),
            "mention"
          ),
    },
  ];

  return {
    asin,
    marketplace,
    sampledReviews: mappedReviews.length,
    mentionTopics: details.length,
    fetchedAt,
    status: details.length || mappedReviews.length ? "ready" : "pending",
    statusMessage: details.length || mappedReviews.length ? undefined : "Sorftime 未返回 Customers Say 或评论样本",
    blocks: localizeReviewBlocks(blocks),
  };
}
