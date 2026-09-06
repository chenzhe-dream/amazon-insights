"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ManualAlexaVocWriteResponseSchema,
  type ManualAlexaVocRecord,
} from "../shared/agent-contracts";
import {
  hasManualAlexaVocText,
  manualAlexaVocPrimaryAsinAdvisory,
} from "./alexa-voc-import-validation";
import {
  deliverAlexaVocResultIfActive,
  discoverAlexaVocNormalizationStatuses,
  pollAlexaVocNormalizationOnce,
  type AlexaVocPollResult,
} from "./lib/alexa-voc-normalization-status-client";
import { manualAlexaVocImportErrorMessage } from "./lib/manual-alexa-voc-import-feedback";
import {
  alexaVocCardKey,
  createAlexaVocImportSubmission,
  initialAlexaVocDraftState,
  initialAlexaVocImportFeedbackState,
  initialAlexaVocState,
  isAlexaVocWriteResponseForSubmission,
  reduceAlexaVocImportFeedback,
  reduceAlexaVocState,
  reduceAlexaVocStatusResponse,
  selectAlexaVocDraft,
  selectAlexaVocImportFeedback,
  selectAlexaVocStatus,
  selectPendingAlexaVocPolls,
  setAlexaVocDraft,
  type ManualVocStatus,
  type OverlayRecord,
} from "./manual-alexa-voc-store";
import {
  manualVocDimensions,
  manualVocDisplayMeta,
  manualVocSourceBadge,
  manualVocWorkflow,
} from "./voc-display-schema";
import { AlexaVocTutorialDialog } from "./alexa-voc-tutorial-dialog";

type ProductOption = { asin: string; brand: string; title?: string };

type Props = Readonly<{
  projectId: string | null;
  runId: string | null;
  products: ProductOption[];
  effectiveVocByAsin: Readonly<Record<string, OverlayRecord | null>>;
  statusByAsin: Readonly<Record<string, ManualVocStatus | undefined>>;
  onImported: (record: ManualAlexaVocRecord) => boolean;
  disabled?: boolean;
  pollingEnabled?: boolean;
}>;

const POLL_INTERVAL_MS = 1_000;

type PollPresentation = Readonly<{
  phase: AlexaVocPollResult["phase"];
  startedAt: number;
  revision?: string;
  message?: string;
}>;

function waitForPoll(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = window.setTimeout(resolve, POLL_INTERVAL_MS);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export function AlexaVocImportPanel({ projectId, runId, products, effectiveVocByAsin, statusByAsin, onImported, disabled = false, pollingEnabled = false }: Props) {
  const defaultAsin = products[0]?.asin ?? "";
  const [asin, setAsin] = useState(defaultAsin);
  const [draftState, setDraftState] = useState(initialAlexaVocDraftState);
  const [importFeedbackState, setImportFeedbackState] = useState(initialAlexaVocImportFeedbackState);
  const [normalizationState, setNormalizationState] = useState(initialAlexaVocState);
  const [pollPresentationByKey, setPollPresentationByKey] = useState<ReadonlyMap<string, PollPresentation>>(new Map());
  const [pollRetryNonce, setPollRetryNonce] = useState(0);
  const [discoveryRetryNonce, setDiscoveryRetryNonce] = useState(0);
  const [discoveryIssue, setDiscoveryIssue] = useState<Readonly<{ scopeKey: string; message: string }> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollControllers = useRef(new Map<string, AbortController>());

  const selectedAsin = products.some(product => product.asin === asin) ? asin : defaultAsin;
  const selected = useMemo(() => products.find(item => item.asin === selectedAsin), [products, selectedAsin]);
  const selectedDraft = projectId && runId
    ? selectAlexaVocDraft(draftState, projectId, runId, selectedAsin)
    : "";
  const primaryAsinAdvisory = manualAlexaVocPrimaryAsinAdvisory(selectedDraft, selectedAsin);
  const effectiveRecord = effectiveVocByAsin[selectedAsin] ?? null;
  const effectiveStatus = statusByAsin[selectedAsin];
  const sourceBadge = manualVocSourceBadge(effectiveRecord);
  const importFeedback = selectAlexaVocImportFeedback(
    importFeedbackState,
    projectId ?? "",
    runId ?? "",
    selectedAsin,
  );
  const { status, message, preview } = importFeedback;
  const normalizationStatus = projectId && runId
    ? selectAlexaVocStatus(normalizationState, projectId, runId, selectedAsin)
    : undefined;
  const normalizationAsinKey = products.map(product => product.asin.trim().toUpperCase()).join(",");
  const discoveryScopeKey = `${projectId ?? ""}:${runId ?? ""}:${normalizationAsinKey}`;
  const selectedPollKey = normalizationStatus && projectId && runId
    ? `${alexaVocCardKey(projectId, runId, selectedAsin)}:${normalizationStatus.fingerprint}`
    : null;
  const pollPresentation = selectedPollKey ? pollPresentationByKey.get(selectedPollKey) : undefined;

  useEffect(() => {
    if (!pollPresentation || pollPresentation.phase === "done" || pollPresentation.phase === "failure") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pollPresentation]);

  useEffect(() => {
    if (!projectId || !runId || !pollingEnabled || !normalizationAsinKey) return;
    const controller = new AbortController();
    void (async () => {
      try {
        await deliverAlexaVocResultIfActive({
          signal: controller.signal,
          operation: () => discoverAlexaVocNormalizationStatuses({
            projectId,
            runId,
            asins: normalizationAsinKey.split(","),
            signal: controller.signal,
          }),
          onResult: result => {
            if (result.phase === "recoverable-error") {
              setDiscoveryIssue({ scopeKey: discoveryScopeKey, message: result.message });
              return;
            }
            setDiscoveryIssue(current => current?.scopeKey === discoveryScopeKey ? null : current);
            setNormalizationState(current => reduceAlexaVocStatusResponse(
              current,
              { projectId, runId },
              result.response,
            ));
          },
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setDiscoveryIssue({ scopeKey: discoveryScopeKey, message: "状态发现暂时失败，请重试读取" });
      }
    })();
    return () => controller.abort();
  }, [discoveryRetryNonce, discoveryScopeKey, normalizationAsinKey, pollingEnabled, projectId, runId]);

  useEffect(() => {
    if (!projectId || !runId || !pollingEnabled) {
      for (const controller of pollControllers.current.values()) controller.abort();
      pollControllers.current.clear();
      return;
    }
    const pending = selectPendingAlexaVocPolls(normalizationState, projectId, runId);
    const activeKeys = new Set(pending.map((record) => `${alexaVocCardKey(projectId, runId, record.asin)}:${record.fingerprint}`));
    for (const [key, controller] of pollControllers.current) {
      if (activeKeys.has(key)) continue;
      controller.abort();
      pollControllers.current.delete(key);
    }
    for (const record of pending) {
      const pollKey = `${alexaVocCardKey(projectId, runId, record.asin)}:${record.fingerprint}`;
      if (pollControllers.current.has(pollKey)) continue;
      const controller = new AbortController();
      pollControllers.current.set(pollKey, controller);
      void (async () => {
        try {
          while (!controller.signal.aborted) {
            const shouldStop = await deliverAlexaVocResultIfActive({
              signal: controller.signal,
              operation: () => pollAlexaVocNormalizationOnce({
                projectId,
                runId,
                asin: record.asin,
                fingerprint: record.fingerprint,
                signal: controller.signal,
              }),
              onResult: observed => {
                setPollPresentationByKey(current => {
                  const next = new Map(current);
                  const previous = next.get(pollKey);
                  next.set(pollKey, {
                    phase: observed.phase,
                    startedAt: previous?.startedAt ?? Date.now(),
                    ...(observed.phase === "applying" ? { revision: observed.revision } : {}),
                    ...(observed.phase === "recoverable-error" ? { message: observed.message } : {}),
                  });
                  return next;
                });
                if (observed.phase === "failure") {
                  setImportFeedbackState(current => reduceAlexaVocImportFeedback(current, {
                    type: "cleared", projectId, runId, asin: record.asin,
                    pendingFingerprint: record.fingerprint,
                  }));
                  setNormalizationState(current => reduceAlexaVocState(current, {
                    type: "setFailure", projectId, runId, asin: record.asin,
                    fingerprint: record.fingerprint, error: observed.error,
                  }));
                  return true;
                }
                if (observed.phase === "done" && !onImported(observed.record)) {
                  setImportFeedbackState(current => reduceAlexaVocImportFeedback(current, {
                    type: "cleared", projectId, runId, asin: record.asin,
                    pendingFingerprint: record.fingerprint,
                  }));
                  setNormalizationState(current => reduceAlexaVocState(current, {
                    type: "clear", projectId, runId, asin: record.asin,
                    fingerprint: record.fingerprint,
                  }));
                  return true;
                }
                if (observed.phase === "done") {
                  setImportFeedbackState(current => reduceAlexaVocImportFeedback(current, {
                    type: "succeeded", projectId, runId, asin: record.asin,
                    message: `导入成功 · PostgreSQL revision ${observed.record.revision}`,
                  }));
                  setNormalizationState(current => reduceAlexaVocState(current, {
                    type: "replaceWithImportSuccess", projectId, runId, asin: record.asin,
                    fingerprint: record.fingerprint, revision: observed.record.revision,
                  }));
                  return true;
                }
                return false;
              },
            });
            if (shouldStop === undefined || shouldStop) return;
            await waitForPoll(controller.signal);
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError")) return;
        } finally {
          if (pollControllers.current.get(pollKey) === controller) pollControllers.current.delete(pollKey);
        }
      })();
    }
  }, [normalizationState, onImported, pollingEnabled, pollRetryNonce, projectId, runId]);

  useEffect(() => () => {
      for (const controller of pollControllers.current.values()) controller.abort();
      pollControllers.current.clear();
  }, [pollingEnabled, projectId, runId]);

  async function handleImport() {
    if (!projectId || !runId || !selectedAsin) return;
    const submission = createAlexaVocImportSubmission({
      projectId,
      runId,
      asin: selectedAsin,
      text: selectedDraft,
    });
    const feedbackScope = submission.scope;
    setImportFeedbackState((current) => reduceAlexaVocImportFeedback(current, {
      type: "started",
      ...feedbackScope,
    }));
    try {
      const response = await fetch("/api/alexa-voc/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission.request),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(manualAlexaVocImportErrorMessage(response.status, payload));
      }
      const parsed = ManualAlexaVocWriteResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("导入响应格式无效");
      if (!isAlexaVocWriteResponseForSubmission(submission, parsed.data)) {
        throw new Error("导入响应 ASIN 与提交目标不一致，已阻止跨列回填");
      }
      if (parsed.data.disposition === "pending") {
        setNormalizationState((current) => reduceAlexaVocState(current, {
          type: "setPending",
          projectId: submission.scope.projectId,
          runId: submission.scope.runId,
          asin: submission.scope.asin,
          fingerprint: parsed.data.normalization.fingerprint,
        }));
        const pollKey = `${alexaVocCardKey(feedbackScope.projectId, feedbackScope.runId, feedbackScope.asin)}:${parsed.data.normalization.fingerprint}`;
        setPollPresentationByKey(current => new Map(current).set(pollKey, {
          phase: "processing",
          startedAt: Date.now(),
        }));
        setImportFeedbackState((current) => reduceAlexaVocImportFeedback(current, {
          type: "succeeded",
          ...feedbackScope,
          message: "已安全提交，正在等待 Alexa VOC 标准化处理",
          pendingFingerprint: parsed.data.normalization.fingerprint,
        }));
        return;
      }
      const imported = parsed.data.record;
      if (!imported) throw new Error("导入响应缺少 VOC 记录");
      if (!onImported(imported)) {
        setImportFeedbackState((current) => reduceAlexaVocImportFeedback(current, {
          type: "cleared",
          ...feedbackScope,
        }));
        setNormalizationState((current) => reduceAlexaVocState(current, {
          type: "clear",
          ...feedbackScope,
        }));
        return;
      }
      setNormalizationState((current) => reduceAlexaVocState(current, {
        type: "replaceWithImportSuccess",
        projectId: submission.scope.projectId,
        runId: submission.scope.runId,
        asin: submission.scope.asin,
        fingerprint: parsed.data.normalization.fingerprint,
        revision: imported.revision,
      }));
      const lines = [
        ...imported.normalizedRecord.attention,
        ...imported.normalizedRecord.positives,
        ...imported.normalizedRecord.negatives,
      ];
      const filled = manualVocDimensions.filter(dimension => imported.normalizedRecord[dimension.key].length > 0).length;
      setImportFeedbackState((current) => reduceAlexaVocImportFeedback(current, {
        type: "succeeded",
        ...feedbackScope,
        message: `导入成功 · 已识别 ${filled} / 7 维 · PostgreSQL revision ${imported.revision}`,
        preview: lines.slice(0, 8),
      }));
    } catch (error) {
      setImportFeedbackState((current) => reduceAlexaVocImportFeedback(current, {
        type: "failed",
        ...feedbackScope,
        message: error instanceof Error ? error.message : "导入失败",
      }));
    }
  }

  return (
    <section className="card alexa-voc-import-card">
      <div className="section-head">
        <div>
          <h3>Alexa 七问 · 快速录入</h3>
          <p>
            可直接粘贴 Alexa 完整回复；支持无序号标题、ASCII/全角括号与复制表格。
          </p>
          <AlexaVocTutorialDialog />
        </div>
        <span className="source-badge">Alexa for Shopping</span>
      </div>

      <ol className="alexa-voc-workflow-list">
        {manualVocWorkflow.map(item => (
          <li key={item.step}>
            <b>{item.step}</b> {item.approach}
          </li>
        ))}
      </ol>

      <div className="alexa-voc-import-form">
        <label className="alexa-voc-import-field">
          <span>目标 ASIN</span>
          <select value={selectedAsin} onChange={event => setAsin(event.target.value)}>
            {products.map(product => (
              <option key={product.asin} value={product.asin}>
                {product.asin} · {product.brand}
              </option>
            ))}
          </select>
        </label>
        {selected?.title ? <p className="alexa-voc-import-subtitle">{selected.title}</p> : null}
        <label className="alexa-voc-import-field">
          <span>Alexa 报告全文</span>
          <textarea
            value={selectedDraft}
            onChange={event => {
              if (!projectId || !runId) return;
              setDraftState(current => setAlexaVocDraft(current, {
                projectId,
                runId,
                asin: selectedAsin,
                text: event.target.value,
              }));
            }}
            placeholder="粘贴包含目标 ASIN 与七问标题的 Alexa 完整回复…"
            rows={12}
          />
        </label>
        {primaryAsinAdvisory ? (
          <p className="alexa-voc-import-warning" role="status">{primaryAsinAdvisory}</p>
        ) : null}
        <div className="alexa-voc-import-actions">
          <button type="button" className="primary-btn" disabled={disabled || !projectId || !runId || status === "loading" || !hasManualAlexaVocText(selectedDraft)} onClick={handleImport}>
            {status === "loading" ? "解析写入中…" : primaryAsinAdvisory ? "确认并解析写入 VOC 矩阵" : "解析并写入 VOC 矩阵"}
          </button>
          <code>npm run alexa:import -- {selectedAsin || "ASIN"}</code>
        </div>
        <p className="alexa-voc-import-hint">
          七问模板：{manualVocDisplayMeta.prompt}
        </p>
        {sourceBadge ? <p className="launch-meta-row">{sourceBadge}</p> : null}
        {!sourceBadge && effectiveStatus === "loading" ? <p className="launch-meta-row">正在读取当前组织的 Manual Alexa VOC…</p> : null}
        {!sourceBadge && effectiveStatus === "missing" ? <p className="pending-box">该 ASIN 尚未录入。</p> : null}
        {effectiveStatus === "source-error" ? <p className="pending-box">运行时 VOC 暂不可用；已保留页面上的较新版本，可重试读取。</p> : null}
        {effectiveStatus === "protocol-conflict" ? <p className="pending-box">服务器返回了冲突 revision；已保留页面上的较新版本，请重试。</p> : null}
        {discoveryIssue?.scopeKey === discoveryScopeKey ? (
          <p className="pending-box">{discoveryIssue.message}。<button type="button" onClick={() => setDiscoveryRetryNonce(value => value + 1)}>重试状态读取</button></p>
        ) : null}
        {normalizationStatus?.status === "pending" ? (
          <div className="pending-box">
            <progress aria-label={`Alexa VOC 导入进度，目标 ${selectedAsin}`} />
            <p>
              目标 {selectedAsin} · {pollPresentation?.phase === "applying" ? `正在应用 revision ${pollPresentation.revision}` : "正在标准化处理"}
            </p>
            <p>已等待 {Math.max(0, Math.floor((now - (pollPresentation?.startedAt ?? now)) / 1000))} 秒</p>
            {effectiveRecord ? <p>当前已有版本：revision {effectiveRecord.revision} · 捕获于 {effectiveRecord.capturedAt}；新结果尚未应用。</p> : null}
            {pollPresentation?.phase === "recoverable-error" ? (
              <p>{pollPresentation.message}。<button type="button" onClick={() => {
                if (selectedPollKey) {
                  pollControllers.current.get(selectedPollKey)?.abort();
                  pollControllers.current.delete(selectedPollKey);
                }
                setPollRetryNonce(value => value + 1);
              }}>立即重试状态读取</button></p>
            ) : null}
          </div>
        ) : null}
        {normalizationStatus?.status === "failure" ? <p className="pending-box">该 ASIN 标准化失败（{normalizationStatus.error}），可重新提交重试。</p> : null}
        {message ? (
          <div className={status === "error" ? "pending-box" : "launch-meta-row"}>{message}</div>
        ) : null}
        {preview.length ? (
          <div className="alexa-voc-import-preview">
            <p>预览（前几行）：</p>
            <ul>
              {preview.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
