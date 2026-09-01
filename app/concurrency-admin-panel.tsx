"use client";

import * as React from "react";

import type {
  ConnectorHealthResponse,
  ConcurrencyAdminResponse,
  SyncLegacyRepairResponse,
  User,
} from "../shared/agent-contracts";
import {
  applyLegacyStatusRepair,
  listConnectorCredentials,
  probeConnector,
  previewLegacyStatusRepair,
  readConcurrencyAdminState,
  refreshSellerSpriteQuota,
  revokeConnectorCredential,
  saveConnectorCredential,
  resetSellerSpriteCircuit,
  setSellerSpritePause,
  updateConcurrencyPolicy,
  updateSellerSpriteQuotaTotal,
  type ConnectorCredentialState,
  type ManagedConnectorId,
} from "./lib/concurrency-admin-browser";
import { isPrimaryAdministrator } from "./lib/primary-admin";

const reactHooks = React as unknown as {
  useState?: typeof React.useState;
  useEffect?: typeof React.useEffect;
  useRef?: typeof React.useRef;
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
const usePanelRef: typeof React.useRef = reactHooks.useRef
  ? reactHooks.useRef
  : ((initial: unknown) => ({ current: initial })) as unknown as typeof React.useRef;

const profileLabel = {
  conservative: "保守档",
  standard: "标准档",
  fast: "高速档",
} as const;

export function ConcurrencyAdminPanel({
  user,
  initialSnapshot = null,
  initialExpanded = false,
  initialCredentialStates = null,
  initialLegacyRepairPreview = null,
}: {
  user: User;
  initialSnapshot?: ConcurrencyAdminResponse | null;
  initialExpanded?: boolean;
  initialCredentialStates?: readonly ConnectorCredentialState[] | null;
  initialLegacyRepairPreview?: SyncLegacyRepairResponse | null;
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
  const [credentialStates, setCredentialStates] = usePanelState<readonly ConnectorCredentialState[]>(
    initialCredentialStates ?? [],
  );
  const [probeHealthByConnector, setProbeHealthByConnector] = usePanelState<
    Partial<Record<ManagedConnectorId, ConnectorHealthResponse>>
  >({});
  const [secretByConnector, setSecretByConnector] = usePanelState<Record<ManagedConnectorId, string>>({
    sellerSprite: "",
    sif: "",
    sorftime: "",
  });
  const [managedSwitchArmed, setManagedSwitchArmed] = usePanelState<Record<ManagedConnectorId, boolean>>({
    sellerSprite: false,
    sif: false,
    sorftime: false,
  });
  const [managedSwitchConfirmed, setManagedSwitchConfirmed] = usePanelState<Record<ManagedConnectorId, boolean>>({
    sellerSprite: false,
    sif: false,
    sorftime: false,
  });
  const pendingCredentialActionRef = usePanelRef<string | null>(null);
  const [legacyJobId, setLegacyJobId] = usePanelState(initialLegacyRepairPreview?.jobId ?? "");
  const [legacyRepairPreview, setLegacyRepairPreview] = usePanelState<SyncLegacyRepairResponse | null>(
    initialLegacyRepairPreview,
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

  usePanelEffect(() => {
    if (!isAdmin || initialCredentialStates) return;
    let active = true;
    void listConnectorCredentials().then(
      (next) => {
        if (active) setCredentialStates(next.connectors);
      },
      () => {
        if (active) setMessage("连接器配置状态暂不可用");
      },
    );
    return () => {
      active = false;
    };
  }, [initialCredentialStates, isAdmin]);

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

  async function refreshConnectorState() {
    const [credentials, concurrency] = await Promise.all([
      listConnectorCredentials(),
      readConcurrencyAdminState(),
    ]);
    setCredentialStates(credentials.connectors);
    setSnapshot(concurrency);
  }

  async function runCredentialAction(
    actionKey: string,
    connectorId: ManagedConnectorId,
    operation: () => Promise<unknown>,
    clearSecret = false,
    isProbe = false,
  ) {
    if (pendingCredentialActionRef.current) return;
    pendingCredentialActionRef.current = actionKey;
    setPending(actionKey);
    setMessage(null);
    let succeeded = false;
    try {
      const result = await operation();
      const probeHealth = isProbe ? result as ConnectorHealthResponse : null;
      if (probeHealth) {
        setProbeHealthByConnector((current) => ({
          ...current,
          [connectorId]: probeHealth,
        }));
      }
      await refreshConnectorState();
      succeeded = true;
      setMessage(probeHealth
        ? `${connectorLabel[connectorId]} · ${probeHealth.available ? "连接正常" : "连接失败"}`
        : "已更新");
    } catch {
      setMessage("更新失败");
    } finally {
      if (clearSecret && succeeded) {
        setSecretByConnector((current) => ({ ...current, [connectorId]: "" }));
      }
      pendingCredentialActionRef.current = null;
      setPending(null);
    }
  }

  async function saveCredentialAndProbe(credential: ConnectorCredentialState) {
    const connectorId = credential.connectorId;
    const actionKey = `credential-save-${connectorId}`;
    if (pendingCredentialActionRef.current) return;
    pendingCredentialActionRef.current = actionKey;
    setPending(actionKey);
    setMessage(null);
    try {
      await saveConnectorCredential(
        connectorId,
        secretByConnector[connectorId],
        credential.source === "environment"
          ? { confirmEnvironmentReplacement: true }
          : {},
      );
    } catch {
      setMessage("凭证保存失败");
      pendingCredentialActionRef.current = null;
      setPending(null);
      return;
    }

    setSecretByConnector((current) => ({ ...current, [connectorId]: "" }));
    setManagedSwitchArmed((current) => ({ ...current, [connectorId]: false }));
    setManagedSwitchConfirmed((current) => ({ ...current, [connectorId]: false }));
    try {
      const health = await probeConnector(connectorId);
      setProbeHealthByConnector((current) => ({ ...current, [connectorId]: health }));
      await refreshConnectorState();
      setMessage(`${connectorLabel[connectorId]} · ${health.available ? "连接正常" : "连接失败"}`);
    } catch {
      try {
        await refreshConnectorState();
      } catch {
        // The credential save is authoritative even if the safe-state refresh is unavailable.
      }
      setMessage("凭证已保存；连接测试失败，请重新测试连接");
    } finally {
      pendingCredentialActionRef.current = null;
      setPending(null);
    }
  }

  async function runLegacyRepairAction(
    actionKey: string,
    operation: () => Promise<SyncLegacyRepairResponse>,
  ) {
    if (pendingCredentialActionRef.current) return;
    pendingCredentialActionRef.current = actionKey;
    setPending(actionKey);
    setMessage(null);
    try {
      setLegacyRepairPreview(await operation());
      setMessage("已更新");
    } catch {
      setMessage("更新失败");
    } finally {
      pendingCredentialActionRef.current = null;
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
  const degradedConnectors = snapshot ? providerDegradations(snapshot) : [];

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
          {degradedConnectors.length > 0 ? (
            <div className="concurrency-admin-notice" role="status">
              <strong>服务降级</strong>
              {degradedConnectors.map(({ connector, causeCode }) => (
                <p key={connector}>{connectorLabel[connector]} · {causeCode}</p>
              ))}
            </div>
          ) : null}
          {credentialStates.length > 0 ? (
            <div className="connector-credential-grid" aria-label="数据源配置">
              {credentialStates.map((credential) => (
                <ConnectorCredentialCard
                  key={credential.connectorId}
                  credential={credential}
                  health={probeHealthByConnector[credential.connectorId] ?? snapshot.connectors[credential.connectorId]}
                  isPrimary={isPrimary}
                  pending={pending}
                  secret={secretByConnector[credential.connectorId]}
                  switchArmed={managedSwitchArmed[credential.connectorId]}
                  switchConfirmed={managedSwitchConfirmed[credential.connectorId]}
                  onSecretChange={(value) => setSecretByConnector((current) => ({
                    ...current,
                    [credential.connectorId]: value,
                  }))}
                  onArmSwitch={() => setManagedSwitchArmed((current) => ({
                    ...current,
                    [credential.connectorId]: true,
                  }))}
                  onSwitchConfirmationChange={(value) => setManagedSwitchConfirmed((current) => ({
                    ...current,
                    [credential.connectorId]: value,
                  }))}
                  onCancelSwitch={() => {
                    setSecretByConnector((current) => ({ ...current, [credential.connectorId]: "" }));
                    setManagedSwitchArmed((current) => ({ ...current, [credential.connectorId]: false }));
                    setManagedSwitchConfirmed((current) => ({ ...current, [credential.connectorId]: false }));
                  }}
                  onSave={() => void saveCredentialAndProbe(credential)}
                  onRevoke={() => runCredentialAction(
                    `credential-revoke-${credential.connectorId}`,
                    credential.connectorId,
                    () => revokeConnectorCredential(credential.connectorId),
                  )}
                  onProbe={() => runCredentialAction(
                    `credential-probe-${credential.connectorId}`,
                    credential.connectorId,
                    () => probeConnector(credential.connectorId),
                    false,
                    true,
                  )}
                />
              ))}
            </div>
          ) : null}
          {isPrimary ? (
            <section className="legacy-repair-panel" aria-label="遗留状态修复">
              <div>
                <h3>遗留状态修复</h3>
                <p>先预览，仅把缺乏验证证据的历史空结果标记为待处理。</p>
              </div>
              <label className="concurrency-admin-control-group">
                <input
                  aria-label="同步 Job ID"
                  value={legacyJobId}
                  disabled={pending !== null}
                  onChange={(event) => {
                    setLegacyJobId(event.target.value);
                    setLegacyRepairPreview(null);
                  }}
                />
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={pending !== null || legacyJobId.trim().length === 0}
                  onClick={() => void runLegacyRepairAction(
                    "legacy-preview",
                    () => previewLegacyStatusRepair(legacyJobId.trim()),
                  )}
                >
                  预览修复
                </button>
              </label>
              {legacyRepairPreview ? (
                <div className="legacy-repair-preview">
                  <strong>候选 {legacyRepairPreview.candidates.length} 项</strong>
                  {legacyRepairPreview.candidates.map((candidate) => (
                    <p key={`${candidate.asin}-${candidate.module}`}>
                      {candidate.asin} · {candidate.module} · LEGACY_UNVERIFIED
                    </p>
                  ))}
                  {legacyRepairPreview.candidates.length > 0 ? (
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={pending !== null}
                      onClick={() => void runLegacyRepairAction(
                        "legacy-apply",
                        () => applyLegacyStatusRepair(
                          legacyRepairPreview.jobId,
                          legacyRepairPreview.version,
                        ),
                      )}
                    >
                      确认应用
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
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

function ConnectorCredentialCard({
  credential,
  health,
  isPrimary,
  pending,
  secret,
  switchArmed,
  switchConfirmed,
  onSecretChange,
  onArmSwitch,
  onSwitchConfirmationChange,
  onCancelSwitch,
  onSave,
  onRevoke,
  onProbe,
}: {
  credential: ConnectorCredentialState;
  health: ConcurrencyAdminResponse["connectors"][ManagedConnectorId];
  isPrimary: boolean;
  pending: string | null;
  secret: string;
  switchArmed: boolean;
  switchConfirmed: boolean;
  onSecretChange(value: string): void;
  onArmSwitch(): void;
  onSwitchConfirmationChange(value: boolean): void;
  onCancelSwitch(): void;
  onSave(): void;
  onRevoke(): void;
  onProbe(): void;
}) {
  const sourceText = credential.source === "managed"
    ? "托管凭证"
    : credential.source === "environment"
      ? "服务器已配置"
      : "未配置";
  const isBusy = pending !== null;
  const isProbePending = pending === `credential-probe-${credential.connectorId}`;
  const isEnvironment = credential.source === "environment";
  const canEditManaged = isPrimary && (!isEnvironment || switchArmed);
  const environmentName = connectorEnvironmentName[credential.connectorId];
  return (
    <article className="connector-credential-card">
      <div>
        <h3>{connectorLabel[credential.connectorId]}</h3>
        <span className="source-badge">{sourceText}</span>
      </div>
      <p>{connectorHealthText(credential, health)}</p>
      {health.checkedAt ? (
        <small>测试时间 {new Date(health.checkedAt).toLocaleString("zh-CN")}</small>
      ) : null}
      <small>
        {credential.version ? `版本 ${credential.version}` : "无托管版本"}
        {credential.updatedAt ? ` · ${new Date(credential.updatedAt).toLocaleString("zh-CN")}` : ""}
      </small>
      {isEnvironment ? (
        <div className="connector-credential-guidance">
          <small>环境变量 <code>{environmentName}</code></small>
          <small>配置文件 <code>{formalStackEnvironmentPath}</code></small>
          <small>直接修改后：重启正式栈，再重新测试连接。</small>
          <small>也可切换为托管凭证；保存后对新任务立即生效，无需重启。</small>
        </div>
      ) : credential.source === "managed" ? (
        <small>托管凭证保存后对新任务立即生效，无需重启，并自动测试连接。</small>
      ) : null}
      {isPrimary && isEnvironment && !switchArmed ? (
        <button
          type="button"
          className="ghost-btn"
          disabled={isBusy}
          onClick={onArmSwitch}
        >
          切换为托管凭证
        </button>
      ) : null}
      {canEditManaged ? (
        <div className="connector-credential-input">
          <label>
            <span>凭证输入</span>
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              disabled={isBusy}
              onChange={(event) => onSecretChange(event.target.value)}
            />
          </label>
          {isEnvironment ? (
            <span className="connector-credential-confirmation">
              <input
                type="checkbox"
                aria-label="我确认改用托管凭证"
                checked={switchConfirmed}
                disabled={isBusy}
                onChange={(event) => onSwitchConfirmationChange(event.target.checked)}
              />
              我确认改用托管凭证；原环境变量将保留但不再优先。
            </span>
          ) : null}
          <button
            type="button"
            className="primary-btn"
            disabled={isBusy || secret.trim().length === 0 || (isEnvironment && !switchConfirmed)}
            onClick={onSave}
          >
            {credential.source === "managed"
              ? "替换托管凭证"
              : isEnvironment
                ? "确认切换并保存"
                : "保存凭证"}
          </button>
          {isEnvironment ? (
            <button type="button" className="ghost-btn" disabled={isBusy} onClick={onCancelSwitch}>
              取消切换
            </button>
          ) : null}
        </div>
      ) : null}
      {isPrimary ? (
        <div className="connector-credential-actions">
          {credential.source === "managed" ? (
            <button type="button" className="ghost-btn" disabled={isBusy} onClick={onRevoke}>撤销凭证</button>
          ) : null}
          {credential.configured ? (
            <button type="button" className="ghost-btn" disabled={isBusy} onClick={onProbe}>
              {isProbePending ? "测试中…" : "测试连接"}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

const formalStackEnvironmentPath = "C:\\Users\\EDY\\Amazon-Product-Opportunity-Insights.runtime\\formal-stack.env";
const connectorEnvironmentName: Readonly<Record<ManagedConnectorId, string>> = Object.freeze({
  sif: "SIF_MCP_SECRET",
  sorftime: "SORFTIME_MCP_KEY",
  sellerSprite: "SELLERSPRITE_SECRET_KEY",
});

function connectorHealthText(
  credential: ConnectorCredentialState,
  health: ConcurrencyAdminResponse["connectors"][ManagedConnectorId],
) {
  if (!credential.configured) return "尚未配置";
  if (health.available) return "连接正常";
  if (!health.checkedAt) return "尚未测试或连接暂不可用";
  return health.reason ? `连接失败 · ${health.reason}` : "连接失败";
}

const connectorLabel = {
  sif: "SIF",
  sorftime: "Sorftime",
  sellerSprite: "SellerSprite",
} as const;

function providerDegradations(snapshot: ConcurrencyAdminResponse) {
  return Object.entries(snapshot.connectors).flatMap(([connector, state]) => {
    const match = state.reason?.match(/^Provider degraded: [a-z-]+ \(([A-Z0-9_]+)\)$/);
    if (!state.configured || state.available || !match || !(connector in connectorLabel)) {
      return [];
    }
    return [{
      connector: connector as keyof typeof connectorLabel,
      causeCode: match[1],
    }];
  });
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
