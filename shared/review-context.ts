import { z } from 'zod';

const sites = z.enum(['US', 'UK', 'DE', 'CA']);
const hosts = { US: 'www.amazon.com', UK: 'www.amazon.co.uk', DE: 'www.amazon.de', CA: 'www.amazon.ca' };
const text = z.string().trim().min(1);
const referenceSchema = z.object({
  reviewId: text.regex(/^R[A-Z0-9]+$/),
  sourceCountry: sites,
  reviewedAt: z.string().date(),
  countryDateText: text.max(300),
  title: text.max(1000), body: text.max(20000),
  rating: z.number().min(1).max(5).optional(),
  sourceUrl: z.string().url(), observedAt: z.string().datetime(),
  relationship: z.literal('same-page-variant-unverified'),
  variationText: z.string().max(1000).optional(),
}).strict();

/** Supplemental observations never enter local review analysis or readiness. */
export const ReviewContextSchema = z.object({
  schemaVersion: z.literal(1),
  organizationId: z.string().uuid(), projectId: z.string().uuid(),
  asin: z.string().regex(/^[A-Z0-9]{10}$/), marketplace: sites,
  page: z.object({
    url: z.string().url(), checkedAt: z.string().datetime(),
    status: z.enum(['available', 'unavailable', 'not-found', 'unknown']),
    localReviews: z.enum(['zero', 'present', 'unknown']),
    identity: z.enum(['asin-confirmed', 'unverified']),
    evidence: text.max(2000), lookupNote: text.max(2000).optional(),
  }).strict(),
  internationalReferences: z.array(referenceSchema).max(100),
}).strict().superRefine((value, ctx) => {
  const expected = `https://${hosts[value.marketplace]}/dp/${value.asin}`;
  if (value.page.url !== expected) ctx.addIssue({code:'custom',message:'Page URL must match exact marketplace and ASIN'});
  if (value.page.status === 'not-found' && (value.page.localReviews !== 'unknown' || value.page.identity !== 'unverified')) ctx.addIssue({code:'custom',message:'Missing page does not prove local review absence or identity'});
  const seen = new Set<string>();
  for (const ref of value.internationalReferences) {
    if (ref.sourceCountry === value.marketplace || ref.sourceUrl !== expected || value.page.identity !== 'asin-confirmed') ctx.addIssue({code:'custom',message:'International reference must have foreign origin and confirmed page association'});
    if (seen.has(ref.reviewId)) ctx.addIssue({code:'custom',message:'Duplicate review ID'});
    seen.add(ref.reviewId);
    if (Date.parse(ref.reviewedAt) > Date.parse(ref.observedAt) || Date.parse(ref.observedAt) > Date.parse(value.page.checkedAt)) ctx.addIssue({code:'custom',message:'Review dates must precede observation and page check'});
  }
});
export type ReviewContext = z.infer<typeof ReviewContextSchema>;
export type ReviewContextScope = {organizationId: string; projectId: string; marketplace: string; asins: readonly string[]};

export function validReviewContextMap(raw: unknown): raw is Record<string,ReviewContext> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.entries(raw).every(([asin,value]) => {
    const parsed=ReviewContextSchema.safeParse(value);
    return parsed.success && parsed.data.asin === asin;
  });
}
export function reviewContextsMatchScope(raw: unknown, scope: ReviewContextScope, cutoff: string): boolean {
  return validReviewContextMap(raw) && Object.keys(scopedReviewContexts(raw,scope,cutoff)).length === Object.keys(raw).length;
}

export function scopedReviewContexts(raw: Record<string, unknown> | undefined, scope: ReviewContextScope, cutoff = new Date().toISOString()): Record<string, ReviewContext> {
  return Object.fromEntries(scope.asins.flatMap(asin => {
    const result = ReviewContextSchema.safeParse(raw?.[asin]);
    if (!result.success) return [];
    const r = result.data;
    return r.asin === asin && r.marketplace === scope.marketplace && r.organizationId === scope.organizationId && r.projectId === scope.projectId && Date.parse(r.page.checkedAt) <= Date.parse(cutoff) ? [[asin, r]] : [];
  }));
}
