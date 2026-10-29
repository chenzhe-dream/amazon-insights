import {z} from 'zod';

// Optional on legacy receipts: adding defaults during parsing would change their hashes.
export const MarketAcquisitionPolicyFields={
 pluginSourceSnapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/).nullable().optional(),
 acquisitionMode:z.enum(['mcp-only/v1','plugin-priority/v1']).optional(),
 mcpFallbackPolicy:z.enum(['saved-only/v1','allow-missing/v1']).optional(),
};
export const newMarketAcquisitionPolicy={acquisitionMode:'plugin-priority/v1',mcpFallbackPolicy:'saved-only/v1'} as const;
export type MarketAcquisitionPolicy={pluginSourceSnapshotId?:string|null;acquisitionMode?:'mcp-only/v1'|'plugin-priority/v1';mcpFallbackPolicy?:'saved-only/v1'|'allow-missing/v1'};
export const marketAcquisitionNotice='优先恢复已存结果并复用插件数据。当前仅使用已保存证据，MCP 缺口保留待补；插件商品数据不代替本地评论、关键词指标或自然月总览统计。';
