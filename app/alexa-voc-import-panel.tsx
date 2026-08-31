"use client";

import { useMemo, useState } from "react";
import { ManualAlexaVocWriteResponseSchema, type ManualAlexaVocRecord } from "../shared/agent-contracts";
import { hasManualAlexaVocText } from "./alexa-voc-import-validation";
import type { ManualVocStatus, OverlayRecord } from "./manual-alexa-voc-store";
import {
  manualVocDimensions,
  manualVocDisplayMeta,
  manualVocSourceBadge,
  manualVocWorkflow,
} from "./voc-display-schema";

type ProductOption = { asin: string; brand: string; title?: string };

type Props = Readonly<{
  products: ProductOption[];
  effectiveVocByAsin: Readonly<Record<string, OverlayRecord | null>>;
  statusByAsin: Readonly<Record<string, ManualVocStatus | undefined>>;
  onImported: (record: ManualAlexaVocRecord) => boolean;
  disabled?: boolean;
}>;

export function AlexaVocImportPanel({ products, effectiveVocByAsin, statusByAsin, onImported, disabled = false }: Props) {
  const defaultAsin = products[0]?.asin ?? "";
  const [asin, setAsin] = useState(defaultAsin);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string[]>([]);

  const selectedAsin = products.some(product => product.asin === asin) ? asin : defaultAsin;
  const selected = useMemo(() => products.find(item => item.asin === selectedAsin), [products, selectedAsin]);
  const effectiveRecord = effectiveVocByAsin[selectedAsin] ?? null;
  const effectiveStatus = statusByAsin[selectedAsin];
  const sourceBadge = manualVocSourceBadge(effectiveRecord);

  async function handleImport() {
    setStatus("loading");
    setMessage("");
    setPreview([]);
    try {
      const response = await fetch("/api/alexa-voc/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin: selectedAsin, text }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : "导入失败";
        throw new Error(error);
      }
      const parsed = ManualAlexaVocWriteResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("导入响应格式无效");
      const imported = parsed.data.record;
      if (!onImported(imported)) return;
      const lines = [
        ...imported.normalizedRecord.attention,
        ...imported.normalizedRecord.positives,
        ...imported.normalizedRecord.negatives,
      ];
      const filled = manualVocDimensions.filter(dimension => imported.normalizedRecord[dimension.key].length > 0).length;
      setPreview(lines.slice(0, 8));
      setStatus("done");
      setMessage(`导入成功 · 已识别 ${filled} / 7 维 · PostgreSQL revision ${imported.revision}`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "导入失败");
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
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder="粘贴包含目标 ASIN 与七问标题的 Alexa 完整回复…"
            rows={12}
          />
        </label>
        <div className="alexa-voc-import-actions">
          <button type="button" className="primary-btn" disabled={disabled || status === "loading" || !hasManualAlexaVocText(text)} onClick={handleImport}>
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
