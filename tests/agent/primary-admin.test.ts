import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../../shared/agent-contracts";
import {
  isPrimaryAdministrator,
  shouldShowBuilderNotice,
  type BuilderNotice,
} from "../../app/lib/primary-admin";

function user(email: string, role: User["role"]): User {
  return {
    id: "018f1f5c-60f0-4b7a-8000-000000000001",
    organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
    email,
    displayName: "Fixture",
    role,
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

test("primary administrator requires the admin role and normalized approved email", () => {
  assert.equal(isPrimaryAdministrator(user("admin@example.com", "admin")), true);
  assert.equal(isPrimaryAdministrator(user("  ADMIN@EXAMPLE.COM  ", "admin")), true);
  assert.equal(isPrimaryAdministrator(user("test-admin@amazon-insights.local", "admin")), false);
  assert.equal(isPrimaryAdministrator(user("other-admin@example.com", "admin")), false);
  assert.equal(isPrimaryAdministrator(user("admin@example.com", "member")), false);
});

test("only path diagnostics are suppressed for non-primary users", () => {
  const diagnostic: BuilderNotice = {
    kind: "path-diagnostic",
    text: "根路径诊断",
  };
  const businessMessages: BuilderNotice[] = [
    { kind: "business", text: "请至少输入 3 个竞品 ASIN" },
    { kind: "business", text: "同步失败，请重试" },
    { kind: "business", text: "已切换至美国站" },
    { kind: "business", text: "已保存到收藏夹" },
  ];
  const primary = user("admin@example.com", "admin");
  const ordinaryAdmin = user("test-admin@amazon-insights.local", "admin");
  const member = user("member@example.com", "member");

  assert.equal(shouldShowBuilderNotice(diagnostic, primary), true);
  assert.equal(shouldShowBuilderNotice(diagnostic, ordinaryAdmin), false);
  assert.equal(shouldShowBuilderNotice(diagnostic, member), false);
  for (const notice of businessMessages) {
    assert.equal(shouldShowBuilderNotice(notice, primary), true);
    assert.equal(shouldShowBuilderNotice(notice, ordinaryAdmin), true);
    assert.equal(shouldShowBuilderNotice(notice, member), true);
  }
});
