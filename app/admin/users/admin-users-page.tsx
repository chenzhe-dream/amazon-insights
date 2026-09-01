"use client";

import { AuthSessionGate } from "../../auth-session-gate";
import {
  AdminUsersAuthenticatedPage,
  type AdminUserPresenceClassNames,
} from "./admin-user-presence";
import styles from "./admin-users.module.css";

const adminUserPresenceClasses = styles as unknown as AdminUserPresenceClassNames;

export function AdminUsersPageBoundary() {
  return (
    <AuthSessionGate>
      {(session) => <AdminUsersAuthenticatedPage session={session} classes={adminUserPresenceClasses} />}
    </AuthSessionGate>
  );
}
