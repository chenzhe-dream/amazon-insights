"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

import type {
  AdminUserPresenceResponse,
  AdminUserPresenceUser,
  InvalidationReason,
  PresenceStatus,
} from "../../../shared/agent-contracts";
import { AuthIdentityControl, type AuthenticatedWebSession } from "../../auth-session-gate";
import {
  AdminUserPresenceLoaderController,
  type AdminUserPresenceLoadState,
} from "../../lib/admin-user-presence-browser";

export type AdminUserPresenceClassNames = Readonly<{
  page: string;
  shell: string;
  header: string;
  title: string;
  actions: string;
  returnLink: string;
  stateCard: string;
  tableViewport: string;
  summaryTable: string;
  status: string;
  details: string;
  detailViewport: string;
  detailTable: string;
  muted: string;
}>;

const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  "recently-online": "近期在线",
  "valid-session-idle": "会话有效但近期无活动",
  "never-logged-in": "从未登录",
  "session-expired": "会话已失效",
  disabled: "账号已禁用",
};

const INVALIDATION_LABELS: Record<Exclude<InvalidationReason, null>, string> = {
  "account-disabled": "账号已禁用",
  revoked: "已撤销",
  expired: "已过期",
};

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatPresenceTime(value: string | null | undefined): string {
  if (!value) return "—";
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "—";
  try {
    return dateTimeFormatter.format(instant);
  } catch {
    return "—";
  }
}

function roleLabel(role: AdminUserPresenceUser["role"]): string {
  return role === "admin" ? "管理员" : "成员";
}

function accountStatusLabel(status: AdminUserPresenceUser["accountStatus"]): string {
  return status === "active" ? "启用" : "禁用";
}

function invalidationLabel(reason: InvalidationReason): string {
  return reason === null ? "有效" : INVALIDATION_LABELS[reason];
}

function StateCard({
  classes,
  children,
  role,
}: {
  classes: AdminUserPresenceClassNames;
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return <section className={classes.stateCard} role={role}>{children}</section>;
}

function RecentLoginDetails({
  account,
  classes,
  user,
}: {
  account: string;
  classes: AdminUserPresenceClassNames;
  user: AdminUserPresenceUser;
}) {
  const records = user.recentLogins.slice(0, 10);
  return (
    <details className={classes.details}>
      <summary>最近登录记录（{records.length}）</summary>
      <div className={classes.detailViewport}>
        {records.length === 0 ? <p className={classes.muted}>暂无登录记录</p> : (
          <table className={classes.detailTable} aria-label={`${account} 最近登录记录`}>
            <thead><tr><th>登录时间</th><th>最后活动</th><th>到期时间</th><th>失效原因</th></tr></thead>
            <tbody>
              {records.map((record, index) => (
                <tr key={`${record.loggedInAt}-${index}`} data-recent-login="true">
                  <td>{formatPresenceTime(record.loggedInAt)}</td>
                  <td>{formatPresenceTime(record.lastActivityAt)}</td>
                  <td>{formatPresenceTime(record.expiresAt)}</td>
                  <td>{invalidationLabel(record.invalidationReason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

function ReadyTable({
  classes,
  data,
}: {
  classes: AdminUserPresenceClassNames;
  data: AdminUserPresenceResponse;
}) {
  return (
    <section aria-label="用户活动数据">
      <p className={classes.muted}>数据截止：{formatPresenceTime(data.asOf)}</p>
      <div className={classes.tableViewport}>
        <table className={classes.summaryTable}>
          <thead>
            <tr>
              <th>状态</th><th>账号</th><th>显示名称</th><th>角色</th><th>账号状态</th>
              <th>登录次数</th><th>最后登录</th><th>最后活动</th><th>有效会话到期</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((user) => (
              <tr key={user.account}>
                <td><span className={classes.status} data-presence-status={user.presenceStatus}>{PRESENCE_LABELS[user.presenceStatus]}</span></td>
                <td>{user.account}</td>
                <td>{user.displayName}</td>
                <td>{roleLabel(user.role)}</td>
                <td>{accountStatusLabel(user.accountStatus)}</td>
                <td>{user.loginCount}</td>
                <td>{formatPresenceTime(user.lastLoginAt)}</td>
                <td>{formatPresenceTime(user.lastActivityAt)}</td>
                <td>
                  {formatPresenceTime(user.validSessionExpiresAt)}
                  <RecentLoginDetails account={user.account} classes={classes} user={user} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AdminUserPresenceView({
  classes,
  state,
}: {
  classes: AdminUserPresenceClassNames;
  state: AdminUserPresenceLoadState;
}) {
  if (state.status === "loading") {
    return <StateCard classes={classes} role="status">正在读取用户活动数据</StateCard>;
  }
  if (state.status === "error") {
    return <StateCard classes={classes} role="alert">{state.message}</StateCard>;
  }
  if (state.status === "empty") {
    return <StateCard classes={classes} role="status">暂无用户数据</StateCard>;
  }
  return <ReadyTable classes={classes} data={state.data} />;
}

export function AdminUserPresenceLoader({
  classes,
}: {
  classes: AdminUserPresenceClassNames;
}) {
  const [controller] = useState(() => new AdminUserPresenceLoaderController());
  const [state, setState] = useState<AdminUserPresenceLoadState>({ status: "loading" });

  useEffect(() => {
    controller.start(setState);
    return () => controller.stop();
  }, [controller]);

  return <AdminUserPresenceView classes={classes} state={state} />;
}

export function AdminUsersAuthenticatedPage({
  adminContent,
  classes,
  session,
}: {
  adminContent?: ReactNode;
  classes: AdminUserPresenceClassNames;
  session: AuthenticatedWebSession;
}) {
  const isAdmin = session.user.role === "admin";
  return (
    <main className={classes.page}>
      <div className={classes.shell}>
        <header className={classes.header}>
          <div className={classes.title}>
            <p>管理</p>
            <h1>用户活动状态</h1>
          </div>
          <div className={classes.actions}>
            <Link className={classes.returnLink} href="/">返回主应用</Link>
            <AuthIdentityControl session={session} />
          </div>
        </header>
        {isAdmin
          ? (adminContent ?? <AdminUserPresenceLoader classes={classes} />)
          : <StateCard classes={classes} role="alert"><h2>无权访问</h2><p>此页面仅供管理员使用。</p></StateCard>}
      </div>
    </main>
  );
}
