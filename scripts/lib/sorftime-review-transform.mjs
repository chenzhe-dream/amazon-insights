import { buildReviewAnalysisFromRecords, customersSayFilters, detectReviewFamily } from "./review-analysis-aggregate.mjs";
import { localizeReviewBlocks, localizeReviewRow, translateReviewLabel } from "./review-label-zh.mjs";

const blockLabels = {
  consumerProfile: "消费者画像",
  scenarios: "使用场景",
  unmet: "未满足需求候选",
  positives: "好评点",
  negatives: "差评点",
  motives: "购买动机",
};

function humanizeKeyword(keyword, family) {
  return translateReviewLabel(
    keyword
      .split(/[\s_-]+/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    family
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

function pickRows(regexRows, csRows, family) {
  const regex = regexRows ?? [];
  const cs = csRows ?? [];
  if (family === "generic") return cs.length ? cs : regex;
  return regex.length ? regex : cs;
}

function rowsFromCustomersSay(details, filter, sortKey, family, limit = 5, allowGenericFallback = true) {
  const total = details.reduce((sum, item) => sum + (Number.isFinite(item.mention) ? item.mention : 0), 0);
  if (total <= 0) return [];
  const matched = [...details].filter(filter);
  const source = matched.length ? matched : family === "generic" && allowGenericFallback ? [...details] : matched;
  return source
    .sort((a, b) => b[sortKey] - a[sortKey] || b.mention - a.mention)
    .slice(0, limit)
    .map(item => localizeReviewRow({
      label: humanizeKeyword(item.keyword, family),
      sharePct: mentionPct(item.mention, total),
      metricKind: "customers_say_topic_share",
      numerator: item.mention,
      denominator: total,
      reason: item.content,
    }, family));
}

export function buildSorftimeReviewAnalysis(asin, marketplace, customersSay, reviews, fetchedAt, context = {}) {
  const family = detectReviewFamily(context);
  const details = customersSay?.details ?? [];
  const mappedReviews = mapReviews(reviews);
  const reviewBlocks = buildReviewAnalysisFromRecords(asin, marketplace, mappedReviews, fetchedAt, context);
  const csFilters = customersSayFilters(family);

  const reviewBlockMap = Object.fromEntries(reviewBlocks.blocks.map(block => [block.key, block]));

  const blocks = [
    {
      key: "consumerProfile",
      label: blockLabels.consumerProfile,
      rows: pickRows(
        reviewBlockMap.consumerProfile?.rows,
        rowsFromCustomersSay(
          details,
          item => csFilters.consumerProfile.test(`${item.keyword} ${item.content}`),
          "mention",
          family
        ),
        family
      ),
    },
    {
      key: "scenarios",
      label: blockLabels.scenarios,
      rows: pickRows(
        reviewBlockMap.scenarios?.rows,
        rowsFromCustomersSay(
          details,
          item => csFilters.scenarios.test(`${item.keyword} ${item.content}`),
          "mention",
          family
        ),
        family
      ),
    },
    {
      key: "unmet",
      label: blockLabels.unmet,
      rows: rowsFromCustomersSay(
        details,
        item =>
          item.negative > 0 && (
            item.negative > item.positive ||
            /\b(?:issue|break|fail|wobbly|dim|glare)\b|don't|doesn't|difficult|poor|need(?:s|ed)?\b/i.test(item.content)
          ),
        "negative",
        family,
        5,
        false
      ),
    },
    {
      key: "positives",
      label: blockLabels.positives,
      rows: rowsFromCustomersSay(
        details,
        item => item.positive > 0 && item.positive > item.negative,
        "positive",
        family,
        5,
        false
      ),
    },
    {
      key: "negatives",
      label: blockLabels.negatives,
      rows: rowsFromCustomersSay(
        details,
        item => item.negative > 0 && item.negative > item.positive,
        "negative",
        family,
        5,
        false
      ),
    },
    {
      key: "motives",
      label: blockLabels.motives,
      rows: pickRows(
        reviewBlockMap.motives?.rows,
        rowsFromCustomersSay(
          details,
          item => csFilters.motives.test(String(item.keyword ?? "")),
          "mention",
          family
        ),
        family
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
    family,
    blocks: localizeReviewBlocks(blocks, family),
  };
}
