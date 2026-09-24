"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  toggleTopSalesMultiSelectFilter,
  type TopSalesMultiSelectFilterState,
} from "./multi-filter";

function filterMultiSelectOptions(options: readonly string[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...options];
  return options.filter(option => option.toLowerCase().includes(normalized));
}

function formatOptionShare(count: number, total: number) {
  if (total <= 0) return "—";
  return `${(Math.round((count / total) * 1000) / 10).toFixed(1)}%`;
}

export function TopSalesMultiSelectFilter({
  prefix,
  options,
  optionCounts,
  filter,
  onChange,
  disabled = false,
  ariaLabel,
  minPanelWidth = 220,
  renderOption,
  onDeleteOption,
  canDeleteOption,
  searchable = false,
  searchPlaceholder = "搜索…",
  showShare = false,
  shareTotal,
}: {
  prefix: string;
  options: string[];
  optionCounts?: ReadonlyMap<string, number>;
  filter: TopSalesMultiSelectFilterState;
  onChange: (next: TopSalesMultiSelectFilterState) => void;
  disabled?: boolean;
  ariaLabel: string;
  minPanelWidth?: number;
  renderOption?: (option: string, count: number) => ReactNode;
  onDeleteOption?: (option: string) => void;
  canDeleteOption?: (option: string) => boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** 在链接数前展示占 TOP 样本比例（如市场准入、商品形态） */
  showShare?: boolean;
  shareTotal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const visibleOptions = useMemo(
    () => (searchable ? filterMultiSelectOptions(options, searchQuery) : options),
    [options, searchQuery, searchable],
  );

  const isOptionDeletable = useCallback(
    (option: string) => Boolean(onDeleteOption) && (canDeleteOption?.(option) ?? true),
    [canDeleteOption, onDeleteOption],
  );
  const showDeleteColumn = useMemo(
    () => Boolean(onDeleteOption) && options.some(option => isOptionDeletable(option)),
    [isOptionDeletable, onDeleteOption, options],
  );
  const effectiveMinPanelWidth =
    minPanelWidth + (showShare ? 48 : 0) + (showDeleteColumn ? 52 : 0);

  const syncPanelPosition = useCallback(() => {
    const anchor = wrapRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = Math.max(effectiveMinPanelWidth, rect.width);
    const maxLeft = Math.max(12, window.innerWidth - panelWidth - 12);
    const left = Math.min(rect.left, maxLeft);
    setPanelStyle({
      position: "fixed",
      top: rect.bottom + 6,
      left,
      width: panelWidth,
      zIndex: 1200,
    });
  }, [effectiveMinPanelWidth]);

  useEffect(() => {
    if (!open) return;
    syncPanelPosition();
    if (searchable) {
      const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [open, searchable, syncPanelPosition]);

  useEffect(() => {
    if (!open) return;
    syncPanelPosition();
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onReposition = () => syncPanelPosition();
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, syncPanelPosition]);

  const allMode = filter === null || filter.length === 0;
  const resolvedShareTotal = useMemo(() => {
    if (typeof shareTotal === "number" && shareTotal > 0) return shareTotal;
    if (!optionCounts?.size) return 0;
    return [...optionCounts.values()].reduce((sum, count) => sum + count, 0);
  }, [optionCounts, shareTotal]);

  const isChecked = (option: string) => allMode || (filter?.includes(option) ?? false);

  const panel =
    open && typeof document !== "undefined" ? (
      <div
        ref={panelRef}
        className="top-sales-multi-select-panel top-sales-multi-select-panel-portal"
        style={panelStyle}
        role="listbox"
        aria-multiselectable="true"
      >
        {searchable ? (
          <input
            ref={searchInputRef}
            type="search"
            className="top-sales-multi-select-search"
            value={searchQuery}
            placeholder={searchPlaceholder}
            aria-label={`${ariaLabel}搜索`}
            onChange={event => setSearchQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
              }
            }}
          />
        ) : null}
        <div className="top-sales-multi-select-panel-actions">
          <button type="button" onClick={() => onChange(null)}>
            显示全部
          </button>
          {showShare || showDeleteColumn ? (
            <div className="top-sales-multi-select-panel-metrics" aria-hidden="true">
              {showShare ? <span>占比</span> : null}
              <span>链接</span>
              {showDeleteColumn ? <span>操作</span> : null}
            </div>
          ) : null}
        </div>
        <ul className="top-sales-multi-select-options">
          {visibleOptions.length ? (
            visibleOptions.map(option => {
            const count = optionCounts?.get(option) ?? 0;
            const deletable = isOptionDeletable(option);
            return (
              <li key={option}>
                <div
                  className={`top-sales-multi-select-option-row${showShare ? " has-share" : ""}${deletable ? " has-delete" : ""}`}
                >
                  <label className="top-sales-multi-select-option">
                    <input
                      type="checkbox"
                      checked={isChecked(option)}
                      onChange={() => onChange(toggleTopSalesMultiSelectFilter(filter, options, option))}
                    />
                    <span className="top-sales-multi-select-option-main">
                      {renderOption ? (
                        renderOption(option, count)
                      ) : (
                        <span className="top-sales-multi-select-option-text">{option}</span>
                      )}
                    </span>
                  </label>
                  {showShare ? (
                    <span className="top-sales-multi-select-option-share">
                      {formatOptionShare(count, resolvedShareTotal)}
                    </span>
                  ) : null}
                  <span className="top-sales-multi-select-option-count">{count} 链接</span>
                  {deletable ? (
                    <button
                      type="button"
                      className="top-sales-multi-select-option-delete"
                      aria-label={`删除形态 ${option}`}
                      title="从本类目形态命名中删除"
                      onMouseDown={event => event.preventDefault()}
                      onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        onDeleteOption?.(option);
                      }}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </li>
            );
            })
          ) : (
            <li className="top-sales-multi-select-empty">没有匹配「{searchQuery.trim()}」的选项</li>
          )}
        </ul>
      </div>
    ) : null;

  return (
    <div className="top-sales-multi-select-filter" ref={wrapRef}>
      <button
        type="button"
        className={`top-sales-multi-select-trigger${!allMode ? " active" : ""}`}
        onClick={() => { setSearchQuery(""); setOpen(current => !current); }}
        disabled={disabled || options.length === 0}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
      >
        {prefix}
        <span className="top-sales-multi-select-caret" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {panel ? createPortal(<div className="market-ui-reference">{panel}</div>, document.body) : null}
    </div>
  );
}
