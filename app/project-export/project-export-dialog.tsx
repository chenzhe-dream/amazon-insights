"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModuleKey } from "../../shared/module-visibility-contracts";
import type { AnalysisProject } from "../project-library-panel";
import { useModalInteraction } from "../lib/use-modal-interaction";
import { visibleExportSections, type ExportSectionId } from "./module-catalog";
import styles from "./project-export.module.css";
import { connectedExportModules, type ExportIdentity } from "./read-export-content";
import { useProjectExport } from "./use-project-export";

export function ProjectExportDialog({ project, visibleModules, identity, onClose }: {
  project: AnalysisProject;
  visibleModules?: readonly ModuleKey[];
  identity?: ExportIdentity;
  onClose: () => void;
}) {
  const titleId = useId();
  const unavailableId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sections = visibleExportSections(visibleModules);
  const [selectedIds, setSelectedIds] = useState<readonly ExportSectionId[]>(() => sections
    .filter(section => !identity || connectedExportModules.includes(section.id)).map(section => section.id));
  const selectedSections = sections.filter(section => selectedIds.includes(section.id));
  const prepared = useProjectExport(project.id, selectedSections.map(section => section.id), identity);
  useModalInteraction(true, dialogRef, closeRef);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.backdrop} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-describedby={unavailableId} className={styles.dialog}>
        <header className={styles.header}>
          <div><h2 id={titleId}>导出预览</h2><p>{project.name} · {project.marketplace} · {project.asins.length} 个 ASIN</p></div>
          <button ref={closeRef} type="button" aria-label="关闭导出预览" className={styles.close} onClick={onClose}>×</button>
        </header>
        <div className={styles.body}>
          <p id={unavailableId} className={styles.notice}>{!identity ? "报告数据与导出服务尚未接入，暂不能生成 HTML。"
            : prepared.preparing ? "正在准备所选模块的已有内容…" : "HTML 快照保留本次预览内容，图片使用在线地址。"}</p>
          {(prepared.result?.kind === "error" || prepared.confirmation?.kind === "error") ? <div role="alert" className={styles.notice}>
            <p>{prepared.result?.kind === "error" ? prepared.result.message : prepared.confirmation?.message}</p>
            <button type="button" className={styles.secondary} onClick={prepared.retry}>重试读取</button>
          </div> : null}
          <div className={styles.columns}>
            <fieldset className={styles.modules}>
              <legend>勾选导出模块</legend>
              {sections.map(section => <label key={section.id} className={styles.option}>
                <input type="checkbox" aria-label={section.label} checked={selectedIds.includes(section.id)}
                  disabled={Boolean(identity && !connectedExportModules.includes(section.id))}
                  onChange={event => setSelectedIds(previous => event.target.checked
                    ? [...previous, section.id] : previous.filter(id => id !== section.id))} />
                <span>{section.label}<small>{identity && connectedExportModules.includes(section.id) ? "读取已有报告" : "内容待接入"}</small></span>
              </label>)}
              {sections.length === 0 ? <p>当前没有可选择的导出模块。</p> : null}
              <p className={styles.help}>{identity ? "保留所选模块的已有内容，预览生成后固定。不会重新分析或调用模型。" : "当前可确认导出范围；接入报告后，将按实际完成情况开放导出。"}</p>
            </fieldset>
            <section className={styles.preview} aria-label="导出范围预览">
              {identity ? <>
                {prepared.result?.kind === "ready" ? <iframe className={styles.reportFrame} title="HTML 快照预览"
                  sandbox="" referrerPolicy="no-referrer" srcDoc={prepared.result.html} /> : null}
                {prepared.preparing ? <p role="status">正在读取完整报告，请稍候…</p> : null}
              </> : <>
              <h3>{project.name} · 项目分析报告</h3>
              <p className={styles.meta}>{[project.marketplace, project.majorCategory, project.categoryLabel].filter(Boolean).join(" · ")}</p>
              <p className={styles.meta}>ASIN：{project.asins.join(" · ")}</p>
              <p className={styles.meta}>最近分析人：{project.latestAnalystName || "未记录"}</p>
              <p className={styles.meta}>项目修改时间：<time dateTime={project.updatedAt}>{formatProjectDate(project.updatedAt)}</time></p>
              <p className={styles.help}>以下为所选模块的内容范围，尚未加载分析数据。</p>
              {selectedSections.map(section => <section key={section.id} className={styles.previewSection}>
                <h4>{section.label}</h4><p>{section.description}</p><span className={styles.pending}>报告内容待接入</span>
              </section>)}
              </>}
              {selectedSections.length === 0 ? <p role="status" className={styles.empty}>请至少勾选一个模块。</p> : null}
            </section>
          </div>
        </div>
        <footer className={styles.footer}>
          <div><span role="status">已选择 {selectedSections.length} 个模块</span><p className={styles.help}>导出格式：HTML · 保留所选模块的已有完整内容。</p>
            {prepared.confirmation?.kind === "sent" ? <span role="status">已发起下载</span> : null}
          </div>
          <div className={styles.actions}><button type="button" className={styles.secondary} onClick={onClose}>取消</button>
            <button type="button" className={styles.primary} disabled={!prepared.canDownload} onClick={() => void prepared.download()} aria-describedby={unavailableId}>
              {prepared.confirmation?.kind === "checking" ? "正在核验…" : "确认并开始导出"}</button></div>
        </footer>
      </section>
    </div>, document.body,
  );
}

function formatProjectDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录" : date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
