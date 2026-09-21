import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthIdentityControl, AuthLoginCard, AuthSessionGate } from "../../../app/auth-session-gate";

const user = {
  id: "018f1f5c-60f0-4b7a-8000-000000000001",
  organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  status: "active" as const,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

let childRenderCount = 0;
const checking = renderToStaticMarkup(createElement(AuthSessionGate, { children: () => {
    childRenderCount += 1;
    return createElement("div", null, "protected-app");
  } },
));
const login = renderToStaticMarkup(createElement(AuthLoginCard, {
  state: { status: "unauthenticated", user: null, message: null, retryAfterSeconds: null },
  email: "",
  password: "",
  onEmailChange: () => {},
  onPasswordChange: () => {},
  onSubmit: () => {},
  dingTalkEnabled: true,
  dingTalkPending: false,
  dingTalkMessage: null,
  dingTalkOAuthHref: "/api/auth/dingtalk/start?returnPath=%2F",
}));
const workbenchRetry = renderToStaticMarkup(createElement(AuthLoginCard, {
  state: { status: "unauthenticated", user: null, message: null, retryAfterSeconds: null },
  email: "",
  password: "",
  onEmailChange: () => {},
  onPasswordChange: () => {},
  onSubmit: () => {},
  dingTalkEnabled: true,
  dingTalkPending: false,
  dingTalkMessage: "钉钉登录暂时不可用",
  dingTalkOAuthHref: "/api/auth/dingtalk/start?returnPath=%2F",
  onDingTalkWorkbenchRetry: () => {},
}));
const identity = renderToStaticMarkup(createElement(AuthIdentityControl, {
  session: {
    user,
    sessionIdentity: "A".repeat(43),
    canViewUserPresence: false,
    revokeUserPresenceAccess: () => {},
    logout: async () => {},
    logoutPending: false,
    logoutError: null,
  },
}));

process.stdout.write(JSON.stringify({ checking, childRenderCount, login, workbenchRetry, identity }));
