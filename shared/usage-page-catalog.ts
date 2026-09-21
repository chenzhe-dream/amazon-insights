export const USAGE_PAGES = {
  overview: "竞品概览", "overview-images": "主图分析", voc: "VOC 核心主题",
  launch: "开品建议", "voc-positioning": "VOC 产品定位", definition: "产品定义",
  checklist: "立项确认清单", keywords: "关键词分析", "keyword-insight": "关键词洞察",
  traffic: "竞品流量", projects: "项目与历史", "keyword-compare": "关键词对比",
  "traffic-promo": "推广分析", "checklist-library": "清单库",
  "market-overview": "市场总览", "market-shapes": "商品形态及价格带",
  "market-keywords": "类目关键词洞察", "market-themes": "类目买家评论见解",
  "admin-users": "用户状态", "admin-usage": "使用统计",
} as const;
export type UsagePageKey = keyof typeof USAGE_PAGES;
export const USAGE_ACTIONS = ["button", "link", "start-analysis", "save-voc", "export", "navigation"] as const;
export function isUsagePage(value: unknown): value is UsagePageKey {
  return typeof value === "string" && Object.hasOwn(USAGE_PAGES, value);
}
