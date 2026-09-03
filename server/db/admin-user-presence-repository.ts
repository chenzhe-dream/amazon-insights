export type AdminUserPresenceHeartbeatResult =
  | "recorded"
  | "throttled"
  | "inactive";

export type AdminUserPresenceRecentLoginFact = Readonly<{
  loggedInAt: string;
  lastActivityAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}>;

export type AdminUserPresenceUserFact = Readonly<{
  account: string;
  displayName: string;
  role: "admin" | "member";
  accountStatus: "active" | "disabled";
  loginCount: number;
  lastLoginAt: string | null;
  lastActivityAt: string | null;
  validSessionExpiresAt: string | null;
  hasValidSession: boolean;
  hasRecentlyActiveValidSession: boolean;
  recentLogins: readonly AdminUserPresenceRecentLoginFact[];
}>;

export type AdminUserPresenceReadInput = Readonly<{
  organizationId: string;
  asOf: string;
}>;

export type AdminUserPresenceReadResult = Readonly<{
  users: readonly AdminUserPresenceUserFact[];
}>;

export type AdminUserPresenceHeartbeatInput = Readonly<{
  organizationId: string;
  userId: string;
  sessionId: string;
  asOf: string;
}>;

export interface AdminUserPresenceRepository {
  listOrganizationUsers(
    input: AdminUserPresenceReadInput,
  ): Promise<AdminUserPresenceReadResult>;
  recordHeartbeat(
    input: AdminUserPresenceHeartbeatInput,
  ): Promise<AdminUserPresenceHeartbeatResult>;
}

export interface AdminUserPresenceRepositoryCapability {
  readonly adminUserPresence: AdminUserPresenceRepository;
}
