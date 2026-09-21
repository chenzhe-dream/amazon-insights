import {z} from 'zod';

export const PresenceQuerySchema = z.strictObject({
  page:z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize:z.coerce.number().pipe(z.union([z.literal(10),z.literal(20),z.literal(50)])).default(10),
  q:z.string().trim().max(100).default(''),
  source:z.enum(['all','dingtalk','local']).default('dingtalk'),
  status:z.enum(['all','recently-online','valid-session-idle','never-logged-in','session-expired','disabled']).default('all'),
});
export type PresenceQuery = z.infer<typeof PresenceQuerySchema>;
export const PresencePaginationSchema = z.strictObject({
  page:z.number().int().positive(),pageSize:z.union([z.literal(10),z.literal(20),z.literal(50)]),
  total:z.number().int().nonnegative(),
});
export const PresenceSummarySchema=z.strictObject({
  total:z.number().int().nonnegative(),recentlyOnline:z.number().int().nonnegative(),neverLoggedIn:z.number().int().nonnegative(),
});
