import {z} from 'zod';
export const LEGACY_PLUGIN_HISTORY_POLICY='plugin-complete-series/v1' as const;
export const PLUGIN_HISTORY_POLICY='plugin-window-coverage/v2' as const;
export const ShapeHistoryPolicySchema=z.enum([LEGACY_PLUGIN_HISTORY_POLICY,PLUGIN_HISTORY_POLICY]);
export const ShapeHistorySelectionSchema=z.object({version:ShapeHistoryPolicySchema,selectedProvider:z.enum(['sellerSprite','sorftime']),nativeField:z.enum(['sale','amount']),sourceSnapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/).nullable(),reason:z.enum(['complete','partial-windows','no-bound-snapshot','identity-conflict','invalid-source','stale','force-refresh','incomplete','conflicting-history','invalid-history','currency-missing','currency-mismatch','history-range-exceeded']),requiredFrom:z.string(),requiredTo:z.string(),missingMonths:z.array(z.string()).max(120),conflictMonths:z.array(z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/)).max(120).optional(),invalidMonths:z.array(z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/)).max(120).optional()}).strict();
export type ShapeHistorySelection=z.infer<typeof ShapeHistorySelectionSchema>;
