import assert from "node:assert/strict";
import test from "node:test";

import { isValidElement } from "react";

import { ConcurrencyAdminPanel } from "../../app/concurrency-admin-panel";
import type { ConcurrencyAdminResponse, User } from "../../shared/agent-contracts";

const now = "2026-08-22T08:00:00.000Z";

function user(email: string, role: User["role"]): User {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    email,
    displayName: email,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function snapshot(overrides: Partial<ConcurrencyAdminResponse> = {}): ConcurrencyAdminResponse {
  return {
    schemaVersion: "1.0.0",
    organizationId: "20000000-0000-4000-8000-000000000001",
    queue: {
      queued: 4,
      running: 2,
      paused: 1,
      terminal: 12,
    },
    policy: {
      version: "conservative-v1",
      profile: "conservative",
      limits: {
        wholeJob: 2,
        sellerSprite: 1,
        sif: 1,
        sorftime: 1,
        model: 1,
        image: 1,
      },
      sellerSpriteRolling: {
        maxAttempts: 15,
        windowMs: 60_000,
      },
    },
    connectors: {
      sellerSprite: {
        configured: true,
        available: false,
        reason: "等待卖家精灵额度",
        checkedAt: now,
        circuit: {
          paused: true,
          manualHold: true,
          reason: "manual-hold",
          updatedAt: now,
        },
      },
      sif: {
        configured: true,
        available: true,
        reason: null,
        checkedAt: now,
        circuit: {
          paused: false,
          manualHold: false,
          reason: null,
          updatedAt: null,
        },
      },
      sorftime: {
        configured: true,
        available: true,
        reason: null,
        checkedAt: now,
        circuit: {
          paused: false,
          manualHold: false,
          reason: null,
          updatedAt: null,
        },
      },
    },
    sellerSpriteQuota: {
      total: null,
      totalLabel: "总额度未知",
      remaining: 30,
      used: null,
      localObservedAttempts: 18,
      source: "provider",
      status: "paused",
      checkedAt: now,
      ageSeconds: 90,
      warning: "等待卖家精灵额度",
    },
    ...overrides,
  };
}

function render(
  account: User,
  data: ConcurrencyAdminResponse | null = snapshot(),
  initialExpanded = false,
) {
  return renderText(ConcurrencyAdminPanel({
    user: account,
    initialSnapshot: data,
    initialExpanded,
  }));
}

function renderText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  if (isValidElement(node)) {
    const element = node as { type: unknown; props: unknown };
    if (typeof element.type === "function") {
      const Component = element.type as (props: unknown) => unknown;
      return renderText(Component(element.props));
    }
    const props = element.props as {
      children?: unknown;
      hidden?: boolean;
      "aria-label"?: unknown;
      placeholder?: unknown;
    };
    if (props.hidden) return "";
    return [
      props["aria-label"],
      props.placeholder,
      renderText(props.children),
    ].filter(Boolean).join("");
  }
  return "";
}

test("members do not render the concurrency administrator panel", () => {
  const html = render(user("member@example.com", "member"));

  assert.equal(html, "");
  assert.doesNotMatch(html, /卖家精灵额度|并发策略|手动刷新/);
});

test("primary admin defaults to the compact safe summary", () => {
  const html = render(user(" ADMIN@EXAMPLE.COM ", "admin"));
  assert.match(html, /并发与额度/);
  assert.match(html, /保守档/);
  assert.match(html, /排队 4/);
  assert.match(html, /运行 2/);
  assert.match(html, /总额度未知/);
  assert.match(html, /展开管理/);
  assert.doesNotMatch(html, /手动刷新|切换策略|配置总额|解除熔断/);
});

test("primary admin expanded view exposes existing controls and a collapse action", () => {
  const html = render(user(" ADMIN@EXAMPLE.COM ", "admin"), snapshot(), true);
  assert.match(html, /收起/);
  assert.match(html, /手动刷新/);
  assert.match(html, /切换策略/);
  assert.match(html, /配置总额/);
  assert.match(html, /恢复卖家精灵/);
  assert.match(html, /解除熔断/);
  assert.doesNotMatch(html, /https?:|authorization|cookie|database|lease|owner/i);
});

test("ordinary admin expands read-only details without mutation controls", () => {
  const html = render(user("ops@example.com", "admin"), snapshot(), true);
  assert.match(html, /只读/);
  assert.match(html, /排队 4/);
  assert.doesNotMatch(html, /手动刷新|切换策略|配置总额|解除熔断/);
});

test("unconfigured SellerSprite uses one consistent Chinese warning", () => {
  const data = snapshot({
    connectors: {
      ...snapshot().connectors,
      sellerSprite: {
        configured: false,
        available: false,
        reason: "SellerSprite credential is not configured",
        checkedAt: now,
        circuit: {
          paused: false,
          manualHold: false,
          reason: null,
          updatedAt: null,
        },
      },
    },
  });
  const html = render(user("admin@example.com", "admin"), data, true);
  assert.match(html, /未配置/);
  assert.match(html, /尚未配置卖家精灵凭证/);
  assert.doesNotMatch(html, /credential is not configured|状态正常/);
});

test("expanded admin view exposes bounded provider degradation diagnostics", () => {
  const data = snapshot({
    connectors: {
      ...snapshot().connectors,
      sif: {
        configured: true,
        available: false,
        reason: "Provider degraded: dns (DNS_NOT_FOUND)",
        checkedAt: now,
        circuit: {
          paused: false,
          manualHold: false,
          reason: "upstream-error",
          updatedAt: now,
        },
      },
    },
  });
  const html = render(user("admin@example.com", "admin"), data, true);

  assert.match(html, /SIF/);
  assert.match(html, /服务降级/);
  assert.match(html, /DNS_NOT_FOUND/);
  assert.doesNotMatch(html, /https?:|authorization|cookie|database|credential/i);
});
