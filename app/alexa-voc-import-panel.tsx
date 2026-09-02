"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlexaVocNormalizationStatusResponseSchema,
  ManualAlexaVocListResponseSchema,
  ManualAlexaVocWriteResponseSchema,
  type ManualAlexaVocRecord,
} from "../shared/agent-contracts";
import { hasManualAlexaVocText } from "./alexa-voc-import-validation";
import { manualAlexaVocImportErrorMessage } from "./lib/manual-alexa-voc-import-feedback";
import {
  alexaVocCardKey,
  createAlexaVocImportSubmission,
  initialAlexaVocDraftState,
  initialAlexaVocImportFeedbackState,
  initialAlexaVocState,
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
  const pollControllers = useRef(new Map<string, AbortController>());

  const selectedAsin = products.some(product => product.asin === asin) ? asin : defaultAsin;
  const selected = useMemo(() => products.find(item => item.asin === selectedAsin), [products, selectedAsin]);
  const selectedDraft = projectId && runId
    ? selectAlexaVocDraft(draftState, projectId, runId, selectedAsin)
    : "";
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
            const query = new URLSearchParams({ projectId, runId, marketplace: "US" });
            query.append("asins", record.asin);
            const response = await fetch(`/api/alexa-voc/pending?${query.toString()}`, {
              credentials: "same-origin",
              signal: controller.signal,
            });
            const payload: unknown = await response.json().catch(() => null);
            if (!response.ok) return;
            const parsed = AlexaVocNormalizationStatusResponseSchema.safeParse(payload);
            if (!parsed.success) return;
            const observed = parsed.data.records.find((item) => item.asin === record.asin && item.fingerprint === record.fingerprint);
            if (!observed || observed.status !== "pending") {
              if (observed?.status === "failure") {
                setImportFeedbackState((current) => reduceAlexaVocImportFeedback(current, {
                  type: "cleared",
                  projectId,
                  runId,
                  asin: record.asin,
                }));
              }
              if (observed?.status === "success") {
                const recordQuery = new URLSearchParams({ projectId, marketplace: "US" });
                recordQuery.append("asins", record.asin);
                const verifiedResponse = await fetch(`/api/alexa-voc?${recordQuery.toString()}`, {
                  credentials: "same-origin",
                  signal: controller.signal,
                });
                const verifiedPayload: unknown = await verifiedResponse.json().catch(() => null);
                const verified = ManualAlexaVocListResponseSchema.safeParse(verifiedPayload);
                const imported = verified.success
                  ? verified.data.records.find((item) => item.asin === record.asin && item.revision === observed.revision)
                  : undefined;
                if (verifiedResponse.ok && imported) onImported(imported);
              }
              setNormalizationState((current) => reduceAlexaVocStatusResponse(current, { projectId, runId }, parsed.data));
              return;
            }
            setNormalizationState((current) => reduceAlexaVocStatusResponse(current, { projectId, runId }, parsed.data));
            await waitForPoll(controller.signal);
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError")) return;
        } finally {
          if (pollControllers.current.get(pollKey) === controller) pollControllers.current.delete(pollKey);
        }
      })();
    }
  }, [normalizationState, onImported, pollingEnabled, projectId, runId]);

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
      if (parsed.data.disposition === "pending") {
        setNormalizationState((current) => reduceAlexaVocState(current, {
          type: "setPending",
          projectId: submission.scope.projectId,
          runId: submission.scope.runId,
          asin: parsed.data.normalization.asin,
          fingerprint: parsed.data.normalization.fingerprint,
        }));
        setImportFeedbackState((current) => reduceAlexaVocImportFeedback(current, {
          type: "succeeded",
          ...feedbackScope,
          message: "已安全提交，正在等待 Alexa VOC 标准化处理",
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
        asin: parsed.data.normalization.asin,
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
        <div className="alexa-voc-import-actions">
          <button type="button" className="primary-btn" disabled={disabled || !projectId || !runId || status === "loading" || !hasManualAlexaVocText(selectedDraft)} onClick={handleImport}>
            {status === "loading" ? "解析写入中…" : "解析并写入 VOC 矩阵"}
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
        {normalizationStatus?.status === "pending" ? <p className="pending-box">该 ASIN 正在标准化处理中。</p> : null}
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
