import {ThemeQuarantineSchema} from './market-theme-quality';
import { z } from 'zod';
import { MarketThemeReportEntrySchema } from './market-module-contracts';

const count = z.number().int().nonnegative().safe(), asin = z.string().regex(/^[A-Z0-9]{10}$/), identity = z.string().min(1).max(512);
const parameter = z.union([z.number(), z.string().regex(/^(0|[1-9]\d*)$/).transform(Number)]).pipe(count.max(1000000));
export const MarketThemeDetailQuerySchema = z.object({ section: z.enum(['groups', 'members', 'asins']).default('groups'), offset: parameter.default(0),
  limit: parameter.pipe(z.number().min(1).max(50)).default(20), groupIndex: parameter.optional() }).strict().refine(q => q.groupIndex === undefined || q.section === 'members');
export const MarketThemeTotalsSchema = z.object({ mention: count, positive: count, negative: count, themeCount: count }).strict();
export const MarketThemeShareSchema = z.object({ metricKind: z.literal('customers_say_topic_share'), numerator: count, denominator: count,
  valuePct: z.number().min(0).max(100).nullable(), denominatorAsins: z.array(asin).max(20) }).strict();
export const MarketThemeTextPreviewSchema = z.object({ text: z.string().max(2000), totalLength: count, truncated: z.boolean() }).strict();
export const MarketThemeDecisionSchema = z.object({ sourceThemeId: identity, status: z.enum(['mapped', 'unknown', 'unavailable']), groupId: identity.nullable(),
  reason: z.string().max(240).nullable(), batchId: identity.nullable() }).strict();
export const MarketThemeLabelSchema = z.object({ groupId: identity, labelZh: z.string().min(1).max(60), definition: z.string().min(1).max(240),
  origin: z.enum(['catalog', 'batch-proposal', 'local-rule']), batchId: identity.nullable(), proposalId: identity.nullable() }).strict();
export const MarketThemeDetailItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), index: count, groupId: identity.nullable(), mappingStatus: z.enum(['mapped', 'unmapped']), labelZh: z.string().max(60).nullable(),
    definition: z.string().max(240).nullable(), labelOrigin: z.enum(['catalog', 'batch-proposal', 'local-rule']).nullable(), sourceLabel: MarketThemeTextPreviewSchema.nullable(), memberCount: count,
    totals: MarketThemeTotalsSchema, topicShare: MarketThemeShareSchema }).strict(),
  z.object({ kind: z.literal('member'), sourceThemeId: identity, asin, sourceRecordId: identity, sourceUpdatedAt: z.string().max(240).nullable(),
    keyword: MarketThemeTextPreviewSchema, content: MarketThemeTextPreviewSchema, mention: count, positive: count, negative: count,
    withinAsinShare: MarketThemeShareSchema, decision: MarketThemeDecisionSchema }).strict(),
  z.object({ kind: z.literal('asin'), asin, status: z.enum(['success', 'empty', 'failed', 'missing']), reason: z.string().max(240).nullable(),
    sourceRecordId: identity.nullable(), fetchedAt: z.string().datetime({ offset: true }).nullable(), totals: MarketThemeTotalsSchema.nullable(), quarantine:ThemeQuarantineSchema.optional(), memberCount: count }).strict(),
]);
export const MarketThemeDetailPageSchema = z.object({ section: z.enum(['groups', 'members', 'asins']), offset: count, limit: count.min(1).max(50), nextOffset: count.nullable(),
  totalItems: count, groupIndex: count.nullable(), metricKind: z.literal('customers_say_topic_share'), reviewDeduplication: z.literal('unavailable'),
  sentimentOverlap: z.literal('not_assumed_disjoint'), totals: MarketThemeTotalsSchema.nullable(),
  display: z.object({ topN: count.nullable(), totalGroupCount: count, displayedGroupCount: count, omittedGroupCount: count }).strict(),
  items: z.array(MarketThemeDetailItemSchema).max(50) }).strict();
export const MarketThemeDetailResponseSchema = z.object({ report: MarketThemeReportEntrySchema, page: MarketThemeDetailPageSchema }).strict();
