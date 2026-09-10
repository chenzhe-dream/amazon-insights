import { z } from 'zod';

const score = z.number().finite().nonnegative();
const percentage = score.max(100);
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
export const TrafficListingDistributionSchema = z.strictObject({ label: z.string().min(1).max(300), score, ratio: percentage });
export const TrafficListingRecordSchema = z.strictObject({
  totalScore: score,
  naturalAd: z.array(TrafficListingDistributionSchema).length(2),
  adChannels: z.array(TrafficListingDistributionSchema).max(30),
  recommendationSources: z.array(TrafficListingDistributionSchema).max(100),
  children: z.array(z.strictObject({ asin, label: z.string().max(1000), image: z.string().max(4000), totalScore: score, sharePct: percentage, organic: score, sp: score, spRecommend: score, sb: score, sbv: score })).max(1000),
  updatedThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export const TrafficListingCollectionSchema = z.strictObject({
  id: z.uuid(), schemaVersion: z.literal('1'), source: z.literal('sif'),
  marketplace: z.literal('US'), period: z.literal('近30天'),
  collectedAt: z.iso.datetime(),
  asins: z.array(asin).min(1).max(10),
  records: z.record(asin, TrafficListingRecordSchema),
}).superRefine((value, ctx) => {
  if (new Set(value.asins).size !== value.asins.length || [...value.asins].sort().join(',') !== Object.keys(value.records).sort().join(',')) ctx.addIssue({ code: 'custom', message: 'Listing collection ASIN scope mismatch' });
});
export type TrafficListingRecord = z.infer<typeof TrafficListingRecordSchema>;
export type TrafficListingCollection = z.infer<typeof TrafficListingCollectionSchema>;
