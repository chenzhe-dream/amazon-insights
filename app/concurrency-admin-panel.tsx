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

const usePanelState: typeof React.useState = "useState" in React
  ? React.useState
  : ((initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => undefined,
    ]) as typeof React.useState;
const usePanelEffect: typeof React.useEffect = "useEffect" in React
  ? React.useEffect
  : (() => undefined) as typeof React.useEffect;

const profileLabel = {
  conservative: "保守档",
  standard: "标准档",
  fast: "高速档",
} as const;

export function ConcurrencyAdminPanel({
  user,
  initialSnapshot = null,
}: {
  user: User;
  initialSnapshot?: ConcurrencyAdminResponse | null;
}) {
  const isAdmin = user.role === "admin";
  const isPrimary = isPrimaryAdministrator(user);
  const [snapshot, setSnapshot] = usePanelState<ConcurrencyAdminResponse | null>(initialSnapshot);
  const [pending, setPending] = usePanelState<string | null>(null);
  const [message, setMessage] = usePanelState<string | null>(null);
  const [totalInput, setTotalInput] = usePanelState("");

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
    const total = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isSafeInteger(total) || total <= 0)) {
      setMessage("请输入有效总额");
      return;
    }
    void mutate("quota-total", () => updateSellerSpriteQuotaTotal(total));
  }

  const quota = snapshot?.sellerSpriteQuota;
  const sellerSprite = snapshot?.connectors.sellerSprite;
  return (
    <section className="card concurrency-admin-panel" aria-label="并发与额度">
      <div className="section-head">
        <div>
          <span className="status-chip">并发与额度</span>
          <h2>队列、策略与卖家精灵额度</h2>
          <p>{isPrimary ? "最高管理员可调整策略" : "只读"}</p>
        </div>
        {snapshot ? <SourceBadgeText text={snapshot.policy.profile} /> : null}
      </div>

      {snapshot ? (
        <>
          <div className="metric-grid">
            <Metric label="策略" value={profileLabel[snapshot.policy.profile]} detail={`SellerSprite ${snapshot.policy.limits.sellerSprite} · 任务 ${snapshot.policy.limits.wholeJob}`} />
            <Metric label="队列" value={`排队 ${snapshot.queue.queued}`} detail={`运行 ${snapshot.queue.running} · 暂停 ${snapshot.queue.paused}`} />
            <Metric label="卖家精灵" value={quota?.totalLabel ?? "总额度未知"} detail={`剩余 ${quota?.remaining ?? "未知"} · 本系统观察 ${quota?.localObservedAttempts ?? 0}`} />
            <Metric label="状态" value={sellerSprite?.circuit.paused ? "已暂停" : "正常"} detail={quota?.warning ?? sellerSprite?.reason ?? "额度状态正常"} />
          </div>

          <div className="sync-status">
            <i />
            {quota?.checkedAt ? `额度更新时间 ${new Date(quota.checkedAt).toLocaleString("zh-CN")}` : "尚未刷新额度"}
          </div>

          {isPrimary ? (
            <div className="builder-actions">
              <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("refresh", refreshSellerSpriteQuota)}>
                {pending === "refresh" ? "刷新中…" : "手动刷新"}
              </button>
              <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("policy", () => updateConcurrencyPolicy(snapshot.policy.profile === "conservative" ? "standard" : "conservative"))}>
                切换策略
              </button>
              <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("pause", () => setSellerSpritePause(!Boolean(sellerSprite?.circuit.paused)))}>
                {sellerSprite?.circuit.paused ? "恢复卖家精灵" : "暂停卖家精灵"}
              </button>
              <button type="button" className="ghost-btn" disabled={pending !== null} onClick={() => void mutate("reset", resetSellerSpriteCircuit)}>
                解除熔断
              </button>
              <form className="builder-actions" onSubmit={submitTotal}>
                <input
                  aria-label="配置总额"
                  value={totalInput}
                  inputMode="numeric"
                  placeholder="配置总额"
                  onChange={(event) => setTotalInput(event.target.value)}
                />
                <button type="submit" className="primary-btn" disabled={pending !== null}>配置总额</button>
              </form>
            </div>
          ) : (
            <p className="traffic-data-note">只读账户可查看状态，不能修改策略、额度或熔断。</p>
          )}
        </>
      ) : (
        <p className="traffic-data-note">{message ?? "正在读取并发与额度状态"}</p>
      )}
      {message ? <p className="auth-login-status" role="status">{message}</p> : null}
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric-card">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function SourceBadgeText({ text }: { text: keyof typeof profileLabel }) {
  return <span className="source-badge">{profileLabel[text]}</span>;
}
