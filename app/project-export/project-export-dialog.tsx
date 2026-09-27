"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModuleKey } from "../../shared/module-visibility-contracts";
import type { AnalysisProject } from "../project-library-panel";
import { useModalInteraction } from "../lib/use-modal-interaction";
import { visibleSnapshotNavigation, type SnapshotPageId } from "./snapshot-navigation-catalog";
import styles from "./project-export.module.css";
import type { ExportIdentity } from "./read-export-eligibility";
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
  const groups = visibleSnapshotNavigation(visibleModules);
  const admitted = groups.flatMap(group => group.pages.map(page => page.id));
  const [selectedIds, setSelectedIds] = useState<readonly SnapshotPageId[]>(() => admitted);
  const pageIds = admitted.filter(id => selectedIds.includes(id));
  const [includeVariants, setIncludeVariants] = useState(true);
  const selectedPages = groups.flatMap(group => group.pages.filter(page => pageIds.includes(page.id)));
  const prepared = useProjectExport(project.id, {pageIds, includeVariants}, identity, visibleModules);
  useModalInteraction(true, dialogRef, closeRef);

  const setPage = (id: SnapshotPageId, checked: boolean) => setSelectedIds(previous => checked
    ? [...previous, id] : previous.filter(value => value !== id));
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
            : prepared.preparing ? "正在准备所选页面的已有内容…" : "HTML 快照保留本次预览内容，图片使用在线地址。"}</p>
          {(prepared.result?.kind === "error" || prepared.confirmation?.kind === "error") ? <div role="alert" className={styles.notice}>
            <p>{prepared.result?.kind === "error" ? prepared.result.message : prepared.confirmation?.message}</p>
            <button type="button" className={styles.secondary} onClick={prepared.retry}>重试读取</button>
          </div> : null}
          <div className={styles.columns}>
            <div className={styles.modules} aria-label="勾选导出页面">
              <h3>勾选导出页面</h3>
              {groups.map(group => {
                const selectedCount = group.pages.filter(page => pageIds.includes(page.id)).length;
                const parentChecked = selectedCount === group.pages.length;
                return <fieldset key={group.id} data-export-group={group.id} className={styles.group}>
                  <legend>{group.label}</legend>
                  <label className={styles.parentOption} data-tone={group.tone}>
                    <input type="checkbox" aria-label={group.label} data-export-page={group.kind === "direct" ? group.pages[0].id : undefined} checked={parentChecked}
                      ref={input => { if (input) input.indeterminate = selectedCount > 0 && !parentChecked; }}
                      onChange={event => setSelectedIds(previous => event.target.checked
                        ? [...previous, ...group.pages.map(page => page.id)]
                        : previous.filter(id => !group.pages.some(page => page.id === id)))} />
                    <span>{group.label}<small>{group.sub}</small></span>
                  </label>
                  {group.kind === "submenu" ? <div className={styles.children}>{group.pages.map(page => <label key={page.id} className={styles.option}>
                    <input type="checkbox" data-export-page={page.id} aria-label={page.label} checked={pageIds.includes(page.id)}
                      onChange={event => setPage(page.id, event.target.checked)} />
                    <span>{page.label}<small>{page.sub}</small></span>
                  </label>)}</div> : null}
                  {group.id === "overview-group" ? <label className={styles.variantOption}>
                    <input type="checkbox" aria-label="包含变体 / 订单" checked={pageIds.includes("overview") && includeVariants} disabled={!pageIds.includes("overview")}
                      onChange={event => setIncludeVariants(event.target.checked)} />包含变体 / 订单
                  </label> : null}
                </fieldset>;
              })}
              {groups.length === 0 ? <p>当前没有可选择的导出页面。</p> : null}
              <p className={styles.help}>选择决定文件包含的页面。预览导航只切换当前阅读页面。</p>
            </div>
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
                <p className={styles.help}>以下为所选页面的内容范围，尚未加载分析数据。</p>
                {selectedPages.map(page => <section key={page.id} className={styles.previewSection}>
                  <h4>{page.label}</h4><p>{page.sub}</p><span className={styles.pending}>报告内容待接入</span>
                </section>)}
              </>}
              {pageIds.length === 0 ? <p role="status" className={styles.empty}>请至少勾选一个页面。</p> : null}
            </section>
          </div>
        </div>
        <footer className={styles.footer}>
          <div><span role="status">已选择 {pageIds.length} 个页面</span><p className={styles.help}>导出格式：HTML · 保留所选页面的已有完整内容。</p>
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
