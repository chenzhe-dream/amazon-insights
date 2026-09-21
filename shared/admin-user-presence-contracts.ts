import { z } from "zod";
import {PresencePaginationSchema,PresenceSummarySchema} from './admin-user-presence-query';
import {UsageBatchSchema,UsageActivityResponseSchema,RECENT_ACTIVITY_WINDOW_MS} from "./usage-analytics-contracts";

const strictObject = z.strictObject;

export function createAdminUserPresenceContracts<
  DateTime extends z.ZodType,
  UserRole extends z.ZodType,
  UserStatus extends z.ZodType,
>(schemas: Readonly<{
  DateTimeSchema: DateTime;
  UserRoleSchema: UserRole;
  UserStatusSchema: UserStatus;
}>) {
  const ActivityRequestSchema = strictObject({usage:UsageBatchSchema.optional()});
  const ActivityResponseSchema = UsageActivityResponseSchema;
  const PresenceStatusSchema = z.enum([
    "disabled",
    "recently-online",
    "valid-session-idle",
    "never-logged-in",
    "session-expired",
  ]);
  const InvalidationReasonSchema = z.enum([
    "account-disabled",
    "revoked",
    "expired",
  ]).nullable();
  const AdminUserPresenceRecentLoginSchema = strictObject({
    loggedInAt: schemas.DateTimeSchema,
    lastActivityAt: schemas.DateTimeSchema.nullable(),
    expiresAt: schemas.DateTimeSchema,
    invalidationReason: InvalidationReasonSchema,
  });
  const AdminUserPresenceUserSchema = strictObject({
    source: z.enum(['dingtalk','local']).optional(),
    account: z.email(),
    displayName: z.string().trim().min(1).max(200),
    role: schemas.UserRoleSchema,
    accountStatus: schemas.UserStatusSchema,
    presenceStatus: PresenceStatusSchema,
    loginCount: z.number().int().nonnegative(),
    lastLoginAt: schemas.DateTimeSchema.nullable(),
    lastActivityAt: schemas.DateTimeSchema.nullable(),
    validSessionExpiresAt: schemas.DateTimeSchema.nullable(),
    recentLogins: z.array(AdminUserPresenceRecentLoginSchema).max(10),
  });
  const AdminUserPresenceResponseSchema = strictObject({
    pagination: PresencePaginationSchema.optional(),
    summary: PresenceSummarySchema.optional(),
    asOf: schemas.DateTimeSchema,
    recentActivityWindowSeconds: z.literal(RECENT_ACTIVITY_WINDOW_MS / 1000),
    users: z.array(AdminUserPresenceUserSchema),
  });

  return {
    ActivityRequestSchema,
    ActivityResponseSchema,
    PresenceStatusSchema,
    InvalidationReasonSchema,
    AdminUserPresenceRecentLoginSchema,
    AdminUserPresenceUserSchema,
    AdminUserPresenceResponseSchema,
  };
}
