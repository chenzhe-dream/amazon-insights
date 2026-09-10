"use client";

import { AuthSessionGate, type AuthenticatedWebSession } from "./auth-session-gate";
import { useWorkspaceController } from "./features/workspace/use-workspace-controller";
import { WorkspaceView } from "./features/workspace/workspace-view";

export function AuthenticatedAmazonOpportunityApp({ authSession }: { authSession: AuthenticatedWebSession }) {
  const controller = useWorkspaceController({ authSession });
  return <WorkspaceView controller={controller} />;
}

export default function Home() {
  return (
    <AuthSessionGate>
      {(authSession) => <AuthenticatedAmazonOpportunityApp authSession={authSession} />}
    </AuthSessionGate>
  );
}
