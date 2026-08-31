import { z } from "zod";

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
  const ActivityRequestSchema = strictObject({});
  const ActivityResponseSchema = strictObject({ ok: z.literal(true) });
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
    asOf: schemas.DateTimeSchema,
    recentActivityWindowSeconds: z.literal(300),
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
