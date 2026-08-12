/** SIF 反查流量词统一查询窗口（对比流量词矩阵 · 流量占比列） */
export const SIF_KEYWORD_QUERY_WINDOW = {
  time_type: "lately",
  time_value: "30",
  listingSearch: true,
};

export function matchesKeywordQueryWindow(record) {
  const window = record?.queryWindow;
  if (!window) return false;
  return (
    window.time_type === SIF_KEYWORD_QUERY_WINDOW.time_type &&
    window.time_value === SIF_KEYWORD_QUERY_WINDOW.time_value &&
    window.listingSearch === SIF_KEYWORD_QUERY_WINDOW.listingSearch
  );
}
