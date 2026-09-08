import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AuthenticatedWebSession } from "../../app/auth-session-gate";
import { AuthIdentityControl } from "../../app/auth-session-gate";
import {
  AdminUserPresenceView,
  AdminUsersAuthenticatedPage,
  formatPresenceTime,
  type AdminUserPresenceClassNames,
} from "../../app/admin/users/admin-user-presence";
import type { AdminUserPresenceResponse, User } from "../../shared/agent-contracts";

const classes: AdminUserPresenceClassNames = new Proxy({}, {
  get: (_target, property) => String(property),
}) as AdminUserPresenceClassNames;

function user(role: User["role"]): User {
  return {
    id: "018f1f5c-60f0-4b7a-8000-000000000001",
    organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
    email: `${role}@example.com`,
    displayName: role === "admin" ? "Admin" : "Member",
    role,
    status: "active",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function session(role: User["role"], canViewUserPresence = false): AuthenticatedWebSession {
  return {
    user: user(role),
    sessionIdentity: "A".repeat(43),
    canViewUserPresence,
    revokeUserPresenceAccess: () => {},
    logout: async () => {},
    logoutPending: false,
    logoutError: null,
  };
}

const statuses = [
  ["recently-online", "近期在线"],
  ["valid-session-idle", "会话有效但近期无活动"],
  ["never-logged-in", "从未登录"],
  ["session-expired", "会话已失效"],
  ["disabled", "账号已禁用"],
] as const;

const recentLogins = Array.from({ length: 10 }, (_, index) => ({
  loggedInAt: `2026-08-${String(30 - index).padStart(2, "0")}T03:00:00.000Z`,
  lastActivityAt: index === 9 ? null : "2026-08-31T03:59:00.000Z",
  expiresAt: "2026-09-01T03:00:00.000Z",
  invalidationReason: ([null, "account-disabled", "revoked", "expired"] as const)[index % 4]!,
}));

const readyResponse: AdminUserPresenceResponse = {
  asOf: "2026-08-31T04:00:00.000Z",
  recentActivityWindowSeconds: 300,
  users: statuses.map(([presenceStatus], index) => ({
    account: `person-${index}@example.com`,
    displayName: `Person ${index}`,
    role: index === 0 ? "admin" : "member",
    accountStatus: presenceStatus === "disabled" ? "disabled" : "active",
    presenceStatus,
    loginCount: index === 0 ? 12 : index,
    lastLoginAt: index === 2 ? null : "2026-08-31T03:00:00.000Z",
    lastActivityAt: index === 2 ? null : "2026-08-31T03:59:00.000Z",
    validSessionExpiresAt: index < 2 ? "2026-09-01T03:00:00.000Z" : null,
    recentLogins: index === 0 ? recentLogins : [],
  })),
};

test("route composes the client boundary, which owns AuthSessionGate before admin content", async () => {
  const page = await readFile(new URL("../../app/admin/users/page.tsx", import.meta.url), "utf8");
  const boundary = await readFile(new URL("../../app/admin/users/admin-users-page.tsx", import.meta.url), "utf8");

  assert.match(page, /<AdminUsersPageBoundary\s*\/>/);
  assert.doesNotMatch(page, /AuthSessionGate|children=|session=>/);
  assert.match(boundary, /^"use client";/);
  assert.match(boundary, /<AuthSessionGate>[\s\S]*?<AdminUsersAuthenticatedPage/);
});

test("capability denial never mounts admin content while a permitted member mounts it", () => {
  let mounts = 0;
  function Probe() {
    mounts += 1;
    return createElement("p", null, "admin-loader-mounted");
  }

  const memberHtml = renderToStaticMarkup(createElement(AdminUsersAuthenticatedPage, {
    session: session("admin", false),
    classes,
    adminContent: createElement(Probe),
  }));
  assert.match(memberHtml, /无权访问/);
  assert.match(memberHtml, /此页面仅供已授权账号查看。/);
  assert.doesNotMatch(memberHtml, /admin-loader-mounted|用户活动数据/);
  assert.equal(mounts, 0);

  const adminHtml = renderToStaticMarkup(createElement(AdminUsersAuthenticatedPage, {
    session: session("member", true),
    classes,
    adminContent: createElement(Probe),
  }));
  assert.match(adminHtml, /admin-loader-mounted/);
  assert.equal(mounts, 1);
});

test("view renders loading, empty, safe error, and ready states", () => {
  const loading = renderToStaticMarkup(createElement(AdminUserPresenceView, { state: { status: "loading" }, classes }));
  const empty = renderToStaticMarkup(createElement(AdminUserPresenceView, { state: { status: "empty", data: { ...readyResponse, users: [] } }, classes }));
  const error = renderToStaticMarkup(createElement(AdminUserPresenceView, { state: { status: "error", message: "用户活动数据暂不可用，请稍后重试" }, classes }));
  const ready = renderToStaticMarkup(createElement(AdminUserPresenceView, { state: { status: "ready", data: readyResponse }, classes }));

  assert.match(loading, /正在读取用户活动数据/);
  assert.match(empty, /暂无用户数据/);
  assert.match(error, /用户活动数据暂不可用，请稍后重试/);
  assert.match(ready, /person-0@example\.com/);
});

test("ready view renders five statuses, eight summary fields, and at most ten expandable records", () => {
  const html = renderToStaticMarkup(createElement(AdminUserPresenceView, {
    state: { status: "ready", data: readyResponse },
    classes,
  }));

  for (const [, label] of statuses) assert.match(html, new RegExp(label));
  for (const label of ["账号", "显示名称", "角色", "账号状态", "登录次数", "最后登录", "最后活动", "有效会话到期"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /<details/);
  assert.match(html, /最近登录记录（10）/);
  assert.equal((html.match(/data-recent-login="true"/g) ?? []).length, 10);
  for (const label of ["登录时间", "最后活动", "到期时间", "失效原因", "账号已禁用", "已撤销", "已过期", "有效"]) {
    assert.match(html, new RegExp(label));
  }
});

test("safe formatting and rendered UI do not expose internal or sensitive vocabulary", () => {
  assert.equal(formatPresenceTime(null), "—");
  assert.equal(formatPresenceTime("malformed"), "—");
  assert.doesNotThrow(() => formatPresenceTime("2026-08-31T04:00:00.000Z"));

  const html = renderToStaticMarkup(createElement(AdminUserPresenceView, {
    state: { status: "ready", data: readyResponse },
    classes,
  }));
  assert.doesNotMatch(html, /cookie|token|hash|password|session[_ -]?id\b|organization[_ -]?id\b|user[_ -]?id\b|credential|ip address|backend-private-sentinel/i);
});

test("identity control renders the users link only with capability and keeps normal account controls", () => {
  const deniedAdmin = renderToStaticMarkup(createElement(AuthIdentityControl, { session: session("admin", false) }));
  const permittedMember = renderToStaticMarkup(createElement(AuthIdentityControl, { session: session("member", true) }));

  assert.doesNotMatch(deniedAdmin, /href="\/admin\/users"|用户状态/);
  assert.match(permittedMember, /href="\/admin\/users"/);
  assert.match(permittedMember, /用户状态/);
  for (const html of [deniedAdmin, permittedMember]) {
    assert.match(html, /修改密码/);
    assert.match(html, /退出登录/);
  }
});
