/** SIF 反查流量词统一查询窗口（对比流量词矩阵 · 流量占比列） */
export const SIF_KEYWORD_QUERY_WINDOW = {
  time_type: "lately",
  time_value: "30",
  listingSearch: true,
};

export function previousCompleteMonthWindow(now = new Date()) {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { time_type: "month", time_value: month.toISOString().slice(0, 10), listingSearch: true };
}

export function matchesKeywordQueryWindow(record, { enabled = process.env.AGENT_SIF_EMPTY_PREVIOUS_MONTH_FALLBACK === "1", now = new Date(), marketplace } = {}) {
  if (marketplace && record?.marketplace !== marketplace) return false;
  const window = record?.queryWindow;
  if (!window) return false;
  if (
    window.time_type === SIF_KEYWORD_QUERY_WINDOW.time_type &&
    window.time_value === SIF_KEYWORD_QUERY_WINDOW.time_value &&
    window.listingSearch === SIF_KEYWORD_QUERY_WINDOW.listingSearch
  ) return true;
  const previous = previousCompleteMonthWindow(now);
  return Boolean(enabled && record.status === "ready" && record.currentEmpty?.terminalReason === "valid-empty" &&
    record.currentEmpty?.queryWindow?.time_type === SIF_KEYWORD_QUERY_WINDOW.time_type &&
    record.currentEmpty?.queryWindow?.time_value === SIF_KEYWORD_QUERY_WINDOW.time_value &&
    record.currentEmpty?.queryWindow?.listingSearch === SIF_KEYWORD_QUERY_WINDOW.listingSearch &&
    window.time_type === previous.time_type && window.time_value === previous.time_value &&
    window.listingSearch === previous.listingSearch);
}
