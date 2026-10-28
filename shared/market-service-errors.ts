/** Public guidance is selected by code, never copied from an upstream exception. */
export const MARKET_SERVICE_ERROR_MESSAGES = {
  MARKET_NODE_PATH_TIMEOUT: '卖家精灵类目路径查询连接超时，尚未创建采集任务。请保留输入，待连接恢复后重试。',
  MARKET_NODE_PATH_UNAVAILABLE: '卖家精灵类目路径查询暂不可用，尚未创建采集任务。请保留输入并检查数据源连接。',
  MARKET_CATEGORY_LOOKUP_UNAVAILABLE: 'Sorftime 类目名称查询暂不可用。请保留输入，稍后重试；已知准确类目节点时可直接输入节点 ID。',
} as const;
export type MarketServiceErrorCode = keyof typeof MARKET_SERVICE_ERROR_MESSAGES;
