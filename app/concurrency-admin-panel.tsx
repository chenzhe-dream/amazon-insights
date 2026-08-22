"use client";

import * as React from "react";

import type { ConcurrencyAdminResponse, User } from "../shared/agent-contracts";
import {
  readConcurrencyAdminState,
  refreshSellerSpriteQuota,
  resetSellerSpriteCircuit,
  setSellerSpritePause,
  updateConcurrencyPolicy,
  updateSellerSpriteQuotaTotal,
} from "./lib/concurrency-admin-browser";
import { isPrimaryAdministrator } from "./lib/primary-admin";

const reactHooks = React as unknown as {
  useState?: typeof React.useState;
  useEffect?: typeof React.useEffect;
};
const usePanelState: typeof React.useState = reactHooks.useState
  ? reactHooks.useState
  : ((initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => undefined,
    ]) as unknown as typeof React.useState;
const usePanelEffect: typeof React.useEffect = reactHooks.useEffect
  ? reactHooks.useEffect
  : (() => undefined) as typeof React.useEffect;

const profileLabel = {
  conservative: "保守档",
  standard: "标准档",
  fast: "高速档",
} as const;

export function ConcurrencyAdminPanel({
  user,
  initialSnapshot = null,
  initialExpanded = false,
}: {
  user: User;
  initialSnapshot?: ConcurrencyAdminResponse | null;
  initialExpanded?: boolean;
}) {
  const isAdmin = user.role === "admin";
  const isPrimary = isPrimaryAdministrator(user);
  const [expanded, setExpanded] = usePanelState(initialExpanded);
  const [snapshot, setSnapshot] = usePanelState<ConcurrencyAdminResponse | null>(initialSnapshot);
  const [pending, setPending] = usePanelState<string | null>(null);
  const [message, setMessage] = usePanelState<string | null>(null);
  const [totalInput, setTotalInput] = usePanelState("");
  const [selectedProfile, setSelectedProfile] = usePanelState<keyof typeof profileLabel>(
    initialSnapshot?.policy.profile ?? "standard",
  );

  usePanelEffect(() => {
    if (!isAdmin || initialSnapshot) return;
    let active = true;
    void readConcurrencyAdminState().then(
      (next) => {
        if (active) setSnapshot(next);
      },
      () => {
        if (active) setMessage("并发与额度状态暂不可用");
      },
    );
    return () => {
      active = false;
    };
  }, [initialSnapshot, isAdmin]);

  if (!isAdmin) return null;

  async function mutate(label: string, operation: () => Promise<ConcurrencyAdminResponse>) {
    if (pending) return;
    setPending(label);
    setMessage(null);
    try {
      setSnapshot(await operation());
      setMessage("已更新");
    } catch {
      setMessage("更新失败");
    } finally {
      setPending(null);
    }
  }

  function submitTotal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = totalInput.trim();
    if (!trimmed) {
      void mutate("quota-total", () => updateSellerSpriteQuotaTotal(null));
      return;
    }
    const total = Number(trimmed);
    if (!Number.isSafeInteger(total) || total <= 0) {
      setMessage("请输入有效总额");
      return;
    }
    void mutate("quota-total", () => updateSellerSpriteQuotaTotal(total));
  }

  const quota = snapshot?.sellerSpriteQuota;
  const sellerSprite = snapshot?.connectors.sellerSprite;
  const presentation = sellerSpritePresentation(sellerSprite, quota);

  return (
    <section
      className={`card concurrency-admin-panel ${expanded ? "is-expanded" : "is-collapsed"}`}
      aria-label="并发与额度"
    >
      <div className="concurrency-admin-heading">
        <div>
          <span className="status-chip">并发与额度</span>
          <h2>{expanded ? "队列、策略与卖家精灵额度" : "并发与额度"}</h2>
          <p>{isPrimary ? "最高管理员可调整策略" : "只读"}</p>
        </div>
        <div className="concurrency-admin-heading-actions">
          {snapshot ? <SourceBadgeText text={snapshot.policy.profile} /> : null}
          <button
            type="button"
            className="ghost-btn concurrency-admin-toggle"
            aria-expanded={expanded}
            aria-controls="concurrency-admin-details"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : "展开管理"}
          </button>
        </div>
      </div>

      {snapshot ? (
        <div className="concurrency-admin-summary" aria-label="并发与额度摘要">
          <Metric label="策略" value={profileLabel[snapshot.policy.profile]} detail={`SellerSprite ${snapshot.policy.limits.sellerSprite} · 任务 ${snapshot.policy.limits.wholeJob}`} />
          <Metric label="队列" value={`排队 ${snapshot.queue.queued}`} detail={`运行 ${snapshot.queue.running} · 暂停 ${snapshot.queue.paused}`} />
          <Metric label="卖家精灵额度" value={quota?.totalLabel ?? "总额度未知"} detail={`剩余 ${quota?.remaining ?? "未知"} · 本系统观察 ${quota?.localObservedAttempts ?? 0}`} />
          <Metric label="连接状态" value={presentation.label} detail={presentation.detail} tone={presentation.tone} />
        </div>
      ) : (
        <p className="traffic-data-note concurrency-admin-loading">{message ?? "正在读取并发与额度状态"}</p>
      )}

      <div
        id="concurrency-admin-details"
        className="concurrency-admin-details"
        hidden={!expanded}
      >
        {snapshot ? (
          <>
            <div className="concurrency-admin-notice">
              {quota?.checkedAt
                ? `额度更新时间 ${new Date(quota.checkedAt).toLocaleString("zh-CN")}`
                : presentation.detail}
            </div>
          {isPrimary ? (
            <div className="concurrency-admin-actions">
              <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("refresh", refreshSellerSpriteQuota)}>
                {pending === "refresh" ? "刷新中…" : "手动刷新"}
              </button>
              <label className="concurrency-admin-control-group">
                <select
                  aria-label="切换策略"
                  value={selectedProfile}
                  disabled={pending !== null}
                  onChange={(event) => setSelectedProfile(event.target.value as keyof typeof profileLabel)}
                >
                  <option value="conservative">保守档</option>
                  <option value="standard">标准档</option>
                  <option value="fast">高速档</option>
                </select>
                <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("policy", () => updateConcurrencyPolicy(selectedProfile))}>
                  切换策略
                </button>
              </label>
              <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("pause", () => setSellerSpritePause(!Boolean(sellerSprite?.circuit.paused)))}>
                {sellerSprite?.circuit.paused ? "恢复卖家精灵" : "暂停卖家精灵"}
              </button>
              <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("reset", resetSellerSpriteCircuit)}>
                解除熔断
              </button>
              <form className="concurrency-admin-control-group" onSubmit={submitTotal}>
                <input
                  aria-label="配置总额"
                  value={totalInput}
                  inputMode="numeric"
                  placeholder="配置总额"
                  onChange={(event) => setTotalInput(event.target.value)}
                />
                <button type="submit" className="primary-btn" disabled={pending !== null}>保存</button>
              </form>
            </div>
          ) : (
            <p className="traffic-data-note concurrency-admin-notice">
              只读账户可查看状态，不能修改策略、额度或熔断。
            </p>
          )}
          </>
        ) : null}
      </div>
      {message ? <p className="auth-login-status" role="status">{message}</p> : null}
    </section>
  );
}

function sellerSpritePresentation(
  connector: ConcurrencyAdminResponse["connectors"]["sellerSprite"] | undefined,
  quota: ConcurrencyAdminResponse["sellerSpriteQuota"] | undefined,
) {
  if (!connector?.configured) {
    return { label: "未配置", detail: "尚未配置卖家精灵凭证", tone: "warning" } as const;
  }
  if (connector.circuit.paused) {
    return {
      label: "已暂停",
      detail: quota?.warning ?? "卖家精灵调用已暂停",
      tone: "warning",
    } as const;
  }
  if (!connector.available) {
    return { label: "暂不可用", detail: "卖家精灵服务暂不可用", tone: "warning" } as const;
  }
  return { label: "正常", detail: "卖家精灵连接正常", tone: "success" } as const;
}

function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <div className={`concurrency-admin-metric tone-${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function SourceBadgeText({ text }: { text: keyof typeof profileLabel }) {
  return <span className="source-badge">{profileLabel[text]}</span>;
}
