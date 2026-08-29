"use client";

import { useMemo, useState } from "react";
import { hasManualAlexaVocText } from "./alexa-voc-import-validation";
import { rufusVocMeta, rufusVocWorkflow } from "./rufus-voc-data";

type ProductOption = { asin: string; brand: string; title?: string };

export function AlexaVocImportPanel({ products }: { products: ProductOption[] }) {
  const defaultAsin = products[0]?.asin ?? "";
  const [asin, setAsin] = useState(defaultAsin);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string[]>([]);

  const selected = useMemo(() => products.find(item => item.asin === asin), [products, asin]);

  async function handleImport() {
    setStatus("loading");
    setMessage("");
    setPreview([]);
    try {
      const response = await fetch("/api/alexa-voc/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin, text }),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        preview?: { attention?: string[]; positives?: string[]; negatives?: string[] };
        filled?: number;
        missing?: string[];
      };
      if (!response.ok) throw new Error(payload.error ?? "导入失败");
      const lines = [
        ...(payload.preview?.attention ?? []),
        ...(payload.preview?.positives ?? []),
        ...(payload.preview?.negatives ?? []),
      ];
      setPreview(lines);
      setStatus("done");
      setMessage(
        `${payload.message ?? "导入成功"} · 已识别 ${payload.filled ?? "?"} / 7 维${
          payload.missing?.length ? ` · 仍缺 ${payload.missing.join(", ")}` : ""
        }`
      );
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
            Alexa 响应通常很快。提交七问并展开 See more 后，复制报告全文粘贴到下方，系统会自动解析并写入七维矩阵格式。
          </p>
        </div>
        <span className="source-badge">Alexa for Shopping</span>
      </div>

      <ol className="alexa-voc-workflow-list">
        {rufusVocWorkflow.map(item => (
          <li key={item.step}>
            <b>{item.step}</b> {item.approach}
          </li>
        ))}
      </ol>

      <div className="alexa-voc-import-form">
        <label className="alexa-voc-import-field">
          <span>目标 ASIN</span>
          <select value={asin} onChange={event => setAsin(event.target.value)}>
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
            placeholder={`粘贴以「${selected?.brand ?? "Brand"}（${asin}） — 顾客洞察完整分析」开头的完整回复…`}
            rows={12}
          />
        </label>
        <div className="alexa-voc-import-actions">
          <button type="button" className="primary-btn" disabled={status === "loading" || !hasManualAlexaVocText(text)} onClick={handleImport}>
            {status === "loading" ? "解析写入中…" : "解析并写入 VOC 矩阵"}
          </button>
          <code>npm run alexa:import -- {asin || "ASIN"}</code>
        </div>
        <p className="alexa-voc-import-hint">
          七问模板：{rufusVocMeta.prompt}
        </p>
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
