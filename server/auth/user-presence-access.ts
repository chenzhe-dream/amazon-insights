import type { AuthenticatedPrincipal } from "./authentication-service";
import type { AuthenticationService } from "./authentication-service";
import type { AuthenticationRepository } from "../db/repository";
import { z } from "zod";

export type UserPresenceAccess = Readonly<{
  canView(principal: AuthenticatedPrincipal): Promise<boolean>;
}>;

type UserPresenceEnvironment = Readonly<Record<string, string | undefined>>;

const OpaqueIdSchema = z.string().trim().min(1).max(200);

function optionalValue(
  env: UserPresenceEnvironment,
  name: string,
  schema: z.ZodType<string>,
): string | null {
  const parsed = schema.safeParse(env[name]);
  return parsed.success ? parsed.data : null;
}

export function createUserPresenceAccess(options: Readonly<{
  env: UserPresenceEnvironment;
  authService: Pick<AuthenticationService, "findPublicUser">;
  repository: AuthenticationRepository | null;
}>): UserPresenceAccess {
  const organizationId = optionalValue(
    options.env,
    "AGENT_USER_PRESENCE_ORGANIZATION_ID",
    OpaqueIdSchema,
  );
  const primaryUserId = optionalValue(
    options.env,
    "AGENT_USER_PRESENCE_PRIMARY_USER_ID",
    OpaqueIdSchema,
  );
  const primaryEmail = optionalValue(
    options.env,
    "AGENT_USER_PRESENCE_PRIMARY_EMAIL",
    z.email(),
  )?.toLowerCase() ?? null;
  const dingTalkUserId = optionalValue(
    options.env,
    "AGENT_USER_PRESENCE_DINGTALK_USER_ID",
    OpaqueIdSchema,
  );
  const dingTalkCorpId = optionalValue(
    options.env,
    "AGENT_USER_PRESENCE_DINGTALK_CORP_ID",
    OpaqueIdSchema,
  );
  const dingTalkSubjectId = optionalValue(
    options.env,
    "AGENT_USER_PRESENCE_DINGTALK_SUBJECT_ID",
    OpaqueIdSchema,
  );

  return Object.freeze({
    async canView(principal) {
      try {
        if (
          principal.kind !== "user" ||
          !organizationId ||
          principal.organizationId !== organizationId
        ) {
          return false;
        }
        const currentUser = await options.authService.findPublicUser(principal.userId);
        if (
          !currentUser ||
          currentUser.id !== principal.userId ||
          currentUser.organizationId !== organizationId ||
          currentUser.status !== "active"
        ) {
          return false;
        }

        if (
          primaryUserId &&
          primaryEmail &&
          currentUser.id === primaryUserId &&
          currentUser.role === "admin" &&
          currentUser.email.trim().toLowerCase() === primaryEmail
        ) {
          return true;
        }

        if (
          !dingTalkUserId ||
          !dingTalkCorpId ||
          !dingTalkSubjectId ||
          currentUser.id !== dingTalkUserId ||
          !options.repository?.findDingTalkIdentityByUserId
        ) {
          return false;
        }
        const binding = await options.repository.findDingTalkIdentityByUserId(
          currentUser.id,
        );
        return Boolean(
          binding &&
          binding.userId === currentUser.id &&
          binding.organizationId === organizationId &&
          binding.corpId === dingTalkCorpId &&
          binding.subjectId === dingTalkSubjectId,
        );
      } catch {
        return false;
      }
    },
  });
}
