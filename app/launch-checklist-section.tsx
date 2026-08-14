"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  formatUsd,
  parseMoneyInput,
  resolveReferralFeeFromProducts,
} from "./amazon-us-referral-fees";
import { downloadBlobFile, exportChecklistDocx } from "./launch-checklist-export";
import {
  checklistSourceLabels,
  parseTableCellOptions,
  type ChecklistFieldSource,
  type LaunchChecklistEntry,
  type LaunchChecklistGroup,
  type LaunchChecklistStructuredTable,
} from "./launch-checklist";
import { buildProductLaunchAnalysis, hasProductLaunchAnalysis } from "./product-launch-analysis";

type LaunchProduct = {
  asin: string;
  brand: string;
  title?: string;
  price?: number | null;
  sales?: number | null;
  rating?: number | null;
  reviews?: number | null;
  launch?: string | null;
  subRankCategory?: string;
  rankCategory?: string;
};

const sectionOrder = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"] as const;
const gateSectionFilter = new Set(["一", "三", "四", "九"]);
/** 硬门槛视图：合规优先于专利，展示序号与清单原章节号分离 */
const gateSectionLayout = [
  { section: "一", display: "一" },
  { section: "四", display: "二" },
  { section: "三", display: "三" },
  { section: "九", display: "四" },
] as const;
type ChecklistViewMode = "gates" | "full";

function itemKey(groupId: string, label: string) {
  return `${groupId}::${label}`;
}

function findPricingModelLinkage(groups: LaunchChecklistGroup[]) {
  const table = groups.find(group => group.id === "pricing-model")?.structuredTable;
  if (!table) return null;
  let sellPriceKey: string | null = null;
  let commissionAmountKey: string | null = null;
  let commissionRatioKey: string | null = null;
  for (const row of table.rows) {
    const label = row[0]?.text ?? "";
    if (label.includes("含税") || label.includes("前台售价")) {
      sellPriceKey = row[1]?.key ?? null;
    }
    if (label.includes("亚马逊佣金")) {
      commissionAmountKey = row[1]?.key ?? null;
      commissionRatioKey = row[2]?.key ?? null;
    }
  }
  if (!sellPriceKey || !commissionAmountKey || !commissionRatioKey) return null;
  return { sellPriceKey, commissionAmountKey, commissionRatioKey };
}

function seedStructuredTableValues(groups: LaunchChecklistGroup[]) {
  const seeded: Record<string, string> = {};
  for (const group of groups) {
    for (const table of [group.structuredTable, group.competitorTable]) {
      if (!table) continue;
      for (const row of table.rows) {
        for (const cell of row) {
          if (cell.text.trim() && !parseTableCellOptions(cell.text)) {
            seeded[cell.key] = cell.text;
          }
        }
      }
    }
  }
  return seeded;
}

function applyCommissionLinkage(
  values: Record<string, string>,
  linkage: { sellPriceKey: string; commissionAmountKey: string; commissionRatioKey: string },
  products: LaunchProduct[],
) {
  const price = parseMoneyInput(values[linkage.sellPriceKey]);
  const fee = resolveReferralFeeFromProducts(products, price);
  return {
    ...values,
    [linkage.commissionRatioKey]: fee.rateLabel,
    [linkage.commissionAmountKey]: fee.fee != null ? formatUsd(fee.fee) : "",
  };
}

function countCheckableItems(groups: LaunchChecklistGroup[]) {
  return groups.reduce((sum, group) => {
    const entries =
      group.entries ??
      group.items.map((label, index) => ({ id: `${group.id}-${index}`, label, source: "manual" as const }));
    return sum + entries.filter(entry => entry.source !== "auto" || group.kind === "veto").length;
  }, 0);
}

function SourceBadge({ source }: { source: ChecklistFieldSource }) {
  return <span className={`launch-checklist-source is-${source}`}>{checklistSourceLabels[source]}</span>;
}

function TableCellEditor({
  cell,
  value,
  onChange,
}: {
  cell: LaunchChecklistStructuredTable["rows"][number][number];
  value: string;
  onChange: (value: string) => void;
}) {
  if (cell.source === "auto") {
    const display = value.trim() || cell.text;
    if (display.trim()) {
      return <span className="launch-checklist-auto-cell is-inline">{display}</span>;
    }
    return (
      <span className="launch-checklist-auto-cell is-inline is-empty">
        {cell.placeholder ?? "自动计算"}
      </span>
    );
  }

  const optionSpec = parseTableCellOptions(cell.text);
  if (optionSpec?.type === "radio") {
    return (
      <div className="launch-checklist-option-group" role="radiogroup" aria-label={cell.key}>
        {optionSpec.options.map(option => (
          <label key={option} className="launch-checklist-option">
            <input
              type="radio"
              name={cell.key}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  if (optionSpec?.type === "single") {
    return (
      <label className="launch-checklist-option is-single">
        <input type="checkbox" checked={value === "✓"} onChange={event => onChange(event.target.checked ? "✓" : "")} />
        <span>{cell.text.trim() === "□" ? "确认" : cell.text.replace("□", "").trim()}</span>
      </label>
    );
  }

  return (
    <input
      className="launch-checklist-cell-input"
      type="text"
      value={value}
      placeholder={cell.placeholder ?? "请填写"}
      onChange={event => onChange(event.target.value)}
    />
  );
}

function StructuredTableView({
  table,
  tableValues,
  onCellChange,
}: {
  table: LaunchChecklistStructuredTable;
  tableValues: Record<string, string>;
  onCellChange: (key: string, value: string) => void;
}) {
  return (
    <div className="launch-checklist-table-wrap">
      <table className="launch-checklist-table">
        <thead>
          <tr>
            {table.headers.map(header => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(row => (
            <tr key={row.map(cell => cell.key).join("-")}>
              {row.map(cell => (
                <td key={cell.key}>
                  <TableCellEditor
                    cell={cell}
                    value={tableValues[cell.key] ?? (parseTableCellOptions(cell.text) ? "" : cell.text)}
                    onChange={next => onCellChange(cell.key, next)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChecklistEntryRow({
  entry,
  checked,
  manualValue,
  onToggle,
  onManualChange,
}: {
  entry: LaunchChecklistEntry;
  checked: boolean;
  manualValue: string;
  onToggle: () => void;
  onManualChange: (value: string) => void;
}) {
  const checkable = entry.source !== "auto";
  const displayValue = entry.autoValue;
  const showInlineInput = entry.source === "manual";
  const labelText = displayValue ? `${entry.label}：` : entry.label;

  return (
    <li className={`launch-checklist-row is-${entry.source}`}>
      {checkable ? (
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={entry.label} />
      ) : (
        <span className="launch-checklist-bullet" aria-hidden="true" />
      )}
      <div className="launch-checklist-row-body">
        {!checkable ? <SourceBadge source={entry.source} /> : null}
        <span className="launch-checklist-row-label">{labelText}</span>
        {displayValue ? <span className="launch-checklist-inline-value">{displayValue}</span> : null}
        {showInlineInput ? (
          <input
            className="launch-checklist-field-input is-inline"
            type="text"
            value={manualValue}
            placeholder={entry.placeholder ?? "请填写"}
            onChange={event => onManualChange(event.target.value)}
          />
        ) : null}
      </div>
    </li>
  );
}

function ChecklistGroupBlock({
  group,
  checked,
  manualValues,
  tableValues,
  onToggle,
  onManualChange,
  onTableChange,
}: {
  group: LaunchChecklistGroup;
  checked: Record<string, boolean>;
  manualValues: Record<string, string>;
  tableValues: Record<string, string>;
  onToggle: (key: string) => void;
  onManualChange: (id: string, value: string) => void;
  onTableChange: (key: string, value: string) => void;
}) {
  const isVeto = group.kind === "veto";
  const entries =
    group.entries ??
    group.items.map((label, index) => ({
      id: `${group.id}-${index}`,
      label,
      source: "manual" as const,
    }));

  return (
    <section className={`launch-checklist-group${isVeto ? " is-veto" : ""}`}>
      <header>
        <h4>{group.title}</h4>
        {group.description ? <p>{group.description}</p> : null}
      </header>

      {group.competitorTable ? (
        <div className="launch-checklist-subblock">
          <h5>竞品快照（系统抓取）</h5>
          <StructuredTableView table={group.competitorTable} tableValues={tableValues} onCellChange={onTableChange} />
        </div>
      ) : null}

      {group.structuredTable ? (
        <StructuredTableView table={group.structuredTable} tableValues={tableValues} onCellChange={onTableChange} />
      ) : null}

      {entries.length ? (
        <ul className={`launch-checklist${isVeto ? " launch-checklist-veto" : ""}`}>
          {entries.map(entry => {
            const key = itemKey(group.id, entry.label);
            return (
              <ChecklistEntryRow
                key={entry.id}
                entry={entry}
                checked={Boolean(checked[key])}
                manualValue={manualValues[entry.id] ?? ""}
                onToggle={() => onToggle(key)}
                onManualChange={value => onManualChange(entry.id, value)}
              />
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function LaunchChecklistSection({
  products,
  onSaveToLibrary,
  savingToLibrary = false,
  canSaveToLibrary = true,
  libraryHref,
  libraryMessage = null,
}: {
  products: LaunchProduct[];
  onSaveToLibrary?: () => void;
  savingToLibrary?: boolean;
  canSaveToLibrary?: boolean;
  libraryHref?: string;
  libraryMessage?: string | null;
}) {
  const analysis = useMemo(() => buildProductLaunchAnalysis(products), [products]);
  const ready = hasProductLaunchAnalysis(products);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [tableValues, setTableValues] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<ChecklistViewMode>("gates");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const pricingLinkage = useMemo(() => findPricingModelLinkage(analysis.checklist), [analysis.checklist]);
  const referralMeta = useMemo(() => resolveReferralFeeFromProducts(products, null), [products]);

  useEffect(() => {
    if (!ready) return;
    setTableValues(prev => {
      const seeded = seedStructuredTableValues(analysis.checklist);
      const next = { ...seeded };
      for (const [key, value] of Object.entries(prev)) {
        if (
          pricingLinkage &&
          (key === pricingLinkage.commissionAmountKey || key === pricingLinkage.commissionRatioKey)
        ) {
          continue;
        }
        if (value !== undefined && value !== "") next[key] = value;
      }
      return pricingLinkage ? applyCommissionLinkage(next, pricingLinkage, products) : next;
    });
  }, [ready, analysis.checklist, pricingLinkage, products]);

  const research = analysis.checklistResearch;
  const visibleSections = viewMode === "gates" ? gateSectionFilter : new Set(sectionOrder);
  const sectionLayout =
    viewMode === "gates"
      ? gateSectionLayout
      : sectionOrder.map(section => ({ section, display: section }));
  const grouped = sectionLayout
    .filter(entry => visibleSections.has(entry.section))
    .map(entry => ({
      ...entry,
      groups: analysis.checklist.filter(group => group.section === entry.section),
    }))
    .filter(entry => entry.groups.length > 0);
  const visibleGroups = grouped.flatMap(entry => entry.groups);
  const totalVisibleItems = countCheckableItems(visibleGroups);
  const visibleCheckedCount = visibleGroups.reduce((sum, group) => {
    const entries =
      group.entries ??
      group.items.map((label, index) => ({ id: `${group.id}-${index}`, label, source: "manual" as const }));
    return (
      sum +
      entries.filter(entry => {
        const checkable = entry.source !== "auto" || group.kind === "veto";
        return checkable && Boolean(checked[itemKey(group.id, entry.label)]);
      }).length
    );
  }, 0);
  const visibleProgress = totalVisibleItems ? Math.round((visibleCheckedCount / totalVisibleItems) * 100) : 0;

  const toggle = (key: string) => {
    setChecked(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleTableChange = (key: string, value: string) => {
    setTableValues(prev => {
      const next = { ...prev, [key]: value };
      if (pricingLinkage && key === pricingLinkage.sellPriceKey) {
        return applyCommissionLinkage(next, pricingLinkage, products);
      }
      return next;
    });
  };

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const exportViewLabel = viewMode === "gates" ? "合规专利硬门槛" : "完整十项清单";
      const blob = await exportChecklistDocx({
        version: analysis.checklistMeta.version,
        viewLabel: exportViewLabel,
        sectionLayout: grouped.map(({ section, display }) => ({ section, display })),
        research,
        groups: visibleGroups,
        manualValues,
        tableValues,
        checked,
      });
      const slug = research.categoryNode.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "-").slice(0, 24);
      const viewSlug = viewMode === "gates" ? "硬门槛" : "完整清单";
      downloadBlobFile(`立项前确认清单-${viewSlug}-${slug}-${analysis.meta.analyzedAt}.docx`, blob);
    } catch (error) {
      const message = error instanceof Error ? error.message : "导出失败，请稍后重试";
      setDownloadError(message);
      console.error("Checklist export failed:", error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="launch-page launch-checklist-page">
      <section className="card launch-block launch-intro-block">
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <span className="status-chip">立项前确认 · 清单 {analysis.checklistMeta.version}</span>
            <h2 className="launch-page-title">产品立项前确认清单</h2>
            <p>
              默认展示专利排查、合规认证与一票否决等硬门槛；可切换至完整十项清单。蓝色为系统已从竞品/VOC/销量自动抓取；黄色为系统预填待核验；绿色为仅需勾选确认；灰色输入框需人工填写。
            </p>
          </div>
          <div className="launch-checklist-head-actions">
            <span className="source-badge">{analysis.meta.productCount} 竞品 · {analysis.meta.dataMonth}</span>
            {libraryHref ? (
              <Link className="ghost-btn" href={libraryHref}>★ 项目确认清单</Link>
            ) : null}
            {onSaveToLibrary ? (
              <button
                type="button"
                className="ghost-btn"
                disabled={savingToLibrary || !canSaveToLibrary}
                onClick={() => onSaveToLibrary()}
              >
                {savingToLibrary ? "保存中…" : "保存到项目确认清单"}
              </button>
            ) : null}
            {ready ? (
              <button
                type="button"
                className="primary-btn launch-checklist-download"
                disabled={downloading}
                onClick={() => void handleDownload()}
              >
                {downloading ? "生成 Word 中…" : "下载清单"}
              </button>
            ) : null}
          </div>
        </div>
        {libraryMessage ? (
          <p className={libraryMessage.includes("失败") || libraryMessage.includes("请至少") ? "launch-checklist-download-error" : "launch-checklist-library-notice"}>
            {libraryMessage}
          </p>
        ) : null}
        {downloadError ? <p className="launch-checklist-download-error">{downloadError}</p> : null}
        <div className="launch-checklist-legend">
          <span><i className="is-auto" /> 系统已抓取</span>
          <span><i className="is-verify" /> 系统预填 · 待核验</span>
          <span><i className="is-check" /> 需人工勾选</span>
          <span><i className="is-manual" /> 需人工填写</span>
        </div>
        <div className="launch-checklist-view-tabs" role="tablist" aria-label="清单视图">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "gates"}
            className={viewMode === "gates" ? "is-active" : undefined}
            onClick={() => setViewMode("gates")}
          >
            合规专利硬门槛
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "full"}
            className={viewMode === "full" ? "is-active" : undefined}
            onClick={() => setViewMode("full")}
          >
            完整十项清单
          </button>
        </div>
        <div className="launch-meta-row">
          <span>类目 <b>{analysis.meta.categoryLabel}</b></span>
          <span>识别品类 <b>{analysis.checklistMeta.verticalLabel}</b></span>
          <span>平台佣金 <b>{referralMeta.feeCategory} · {referralMeta.rateLabel}</b></span>
          <span>待核验/填写 <b>{totalVisibleItems}</b> 项</span>
          <span>政策 <b>{analysis.checklistMeta.policy}</b></span>
        </div>
        {ready && totalVisibleItems > 0 ? (
          <div className="launch-checklist-progress" aria-label={`已确认 ${visibleCheckedCount} / ${totalVisibleItems} 项`}>
            <div className="launch-checklist-progress-bar">
              <i style={{ width: `${visibleProgress}%` }} />
            </div>
            <span>
              已核验 <b>{visibleCheckedCount}</b> / {totalVisibleItems} · {visibleProgress}%
            </span>
          </div>
        ) : null}
      </section>

      {ready ? (
        <section className="card launch-block launch-checklist-research-card">
          <div className="launch-section-head">
            <div className="launch-section-head-main">
              <h3>调研数据回填（系统已抓取）</h3>
              <p>以下字段由当前竞品 ASIN、VOC 七维与 Sorftime 销量自动带入</p>
            </div>
          </div>
          <div className="launch-checklist-research-grid is-compact">
            <div><span>细分类目</span><b>{research.categoryNode}</b></div>
            <div><span>识别品类</span><b>{research.verticalLabel}</b></div>
            <div><span>BSR 大类</span><b>{referralMeta.rankCategory}</b></div>
            <div><span>平台佣金类目</span><b>{referralMeta.feeCategory}</b></div>
            <div><span>佣金比例</span><b>{referralMeta.rateLabel}</b></div>
            <div><span>对标 ASIN</span><b>{research.asinList}</b></div>
            <div><span>品牌样本</span><b>{research.brands}</b></div>
            <div><span>售价区间</span><b>{research.priceBand}</b></div>
            <div><span>样本月销</span><b>{research.sampleSales}</b></div>
            <div><span>顾客关注</span><b>{research.topAttention}</b></div>
            <div><span>差评 Top</span><b>{research.topNegative}</b></div>
            <div><span>未满足 Top</span><b>{research.topUnmet}</b></div>
            <div><span>首要机会</span><b>{research.topOpportunity}</b></div>
            <div><span>目标人群</span><b>{research.targetAudience}</b></div>
            <div><span>核心场景</span><b>{research.coreScenarios}</b></div>
            <div><span>建议目标价</span><b>{research.targetPrice}</b></div>
            <div><span>立项结论参考</span><b>{research.verdictTitle}</b></div>
          </div>
        </section>
      ) : null}

      {!ready ? (
        <section className="card launch-block">
          <div className="pending-box">
            待 VOC 核心主题或 Sorftime 智能评论分析就绪后，自动生成完整确认清单。请先在「竞品VOC 汇总」页确认七维数据已同步。
          </div>
        </section>
      ) : (
        <section className="card launch-block">
          <div className="launch-section-head">
            <div className="launch-section-head-main">
              <h3>{viewMode === "gates" ? "合规专利硬门槛确认" : "逐项确认"}</h3>
              <p>
                {viewMode === "gates"
                  ? "按确认顺序：基本信息 → 合规认证 → 专利检索 → 一票否决；红灯暂停立项，黄灯需专业复核"
                  : "完整十项清单含市场、利润、MOQ、供应链与评分会签；导出时会合并系统值与人工输入"}
              </p>
            </div>
          </div>
          <div className="launch-section-body">
            <div className="launch-checklist-sections">
              {grouped.map(({ section, display, groups }) => (
                <div key={section} className="launch-checklist-section-block">
                  <h3 className="launch-checklist-section-title">第{display}部分</h3>
                  <div className="launch-checklist-groups">
                    {groups.map(group => (
                      <ChecklistGroupBlock
                        key={group.id}
                        group={group}
                        checked={checked}
                        manualValues={manualValues}
                        tableValues={tableValues}
                        onToggle={toggle}
                        onManualChange={(id, value) => setManualValues(prev => ({ ...prev, [id]: value }))}
                        onTableChange={handleTableChange}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <p className="voc-source-footnote launch-footnote">
        清单引擎：launch-checklist.ts · {analysis.checklistMeta.version} · 更新 {analysis.meta.analyzedAt}
        {" · "}佣金口径：sell.amazon.com/pricing（US）
      </p>
    </div>
  );
}
