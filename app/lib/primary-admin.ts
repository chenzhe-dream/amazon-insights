import type { User } from "../../shared/agent-contracts";

export const PRIMARY_ADMIN_EMAIL = "admin@example.com";

export type BuilderNotice = Readonly<{
  kind: "path-diagnostic" | "business";
  text: string;
}>;

export function isPrimaryAdministrator(user: User): boolean {
  return user.role === "admin"
    && user.email.trim().toLowerCase() === PRIMARY_ADMIN_EMAIL;
}

export function shouldShowBuilderNotice(
  notice: BuilderNotice,
  user: User,
): boolean {
  return notice.kind !== "path-diagnostic" || isPrimaryAdministrator(user);
}
