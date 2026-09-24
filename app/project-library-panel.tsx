"use client";

import Link from "next/link";
import { projectSegmentName } from "../shared/project-segment-name";
import { localAgentFetch, localAgentErrorMessage } from "./lib/local-agent-browser";
import { LocalDataProjectsResponseSchema } from "../shared/agent-contracts";
import "./project-library-pagination.css";
import { PROJECT_TIME_SORT_OPTIONS, projectTimeValues, type ProjectTimeSort } from "../shared/project-library-time";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AnalysisProjectFavorites } from "./use-analysis-project-favorites";
import type { ModuleKey } from "../shared/module-visibility-contracts";
import { ProjectExportButton } from "./project-export/project-export-button";
import { ProjectExportDialog } from "./project-export/project-export-dialog";
import type { ExportIdentity } from "./project-export/read-export-content";
import {
  AMAZON_MAJOR_CATEGORIES,
  AMAZON_MAJOR_CATEGORY_IDS,
  amazonMajorCategoryLabel,
  normalizeAmazonMajorCategory,
} from "./amazon-major-categories";

export type ProjectKind = "analysis" | "keyword-compare" | "traffic-promo" | "checklist";

export type AnalysisProject = {
  id: string;
  sourceProjectId?: string | null;
  kind?: ProjectKind;
  slug?: string | null;
  name: string;
  majorCategory: string | null;
  categoryLabel: string | null;
  marketplace: string;
  asins: string[];
  note: string | null;
  createdBy: string | null;
  latestAnalystName?: string | null;
  createdAt: string;
  updatedAt: string;
};

const AUTHOR_KEY = "amz-lens-project-author";

export { AMAZON_MAJOR_CATEGORIES, AMAZON_MAJOR_CATEGORY_IDS } from "./amazon-major-categories";

const KIND_UI: Record<
  ProjectKind,
  {
    saveTitle: string;
    saveHint: string;
    updateAsins: string;
    listTitle: string;
    listHint: string;
    editBtn: string;
    refreshBtn: string | null;
  }
> = {
  analysis: {
    saveTitle: "保存当前对标池",
    saveHint: "保存后进入历史项目；点击收藏后才会出现在已收藏中。",
    updateAsins: "更新当前项目 ASIN",
    listTitle: "已收藏项目",
    listHint: "团队共享，点击加载即可切换对标 ASIN 组合。",
    editBtn: "编辑",
    refreshBtn: null,
  },
  "keyword-compare": {
    saveTitle: "保存 / 追加 ASIN",
    saveHint: "将当前流量词对比组合保存为收藏项目；也可在下方编辑已有项目并追加新 ASIN。",
    updateAsins: "追加 / 更新当前项目 ASIN",
    listTitle: "流量词对比项目",
    listHint: "每个项目一行；可打开矩阵、刷新关键词数据，或编辑追加 ASIN。",
    editBtn: "编辑 / 加 ASIN",
    refreshBtn: "刷新词数据",
  },
  "traffic-promo": {
    saveTitle: "保存 / 追加 ASIN",
    saveHint: "将当前竞品推广能力分析组合保存为收藏项目；也可在下方编辑已有项目并追加新 ASIN。",
    updateAsins: "追加 / 更新当前项目 ASIN",
    listTitle: "推广能力分析项目",
    listHint: "每个项目一行；可打开流量分析页、刷新流量数据，或编辑追加 ASIN。",
    editBtn: "编辑 / 加 ASIN",
    refreshBtn: "刷新流量数据",
  },
  checklist: {
    saveTitle: "保存 / 追加 ASIN",
    saveHint: "将当前立项前确认清单对应的 ASIN 组合保存为收藏项目；也可在下方编辑已有项目并追加新 ASIN。",
    updateAsins: "追加 / 更新当前项目 ASIN",
    listTitle: "项目确认清单",
    listHint: "每个项目一行；可打开立项前确认清单、刷新竞品数据，或编辑追加 ASIN。",
    editBtn: "编辑 / 加 ASIN",
    refreshBtn: "刷新清单数据",
  },
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseAsinInput(raw: string) {
  return raw
    .toUpperCase()
    .split(/[\s,，、;；|/]+/)
    .map(value => value.trim())
    .filter(value => /^[A-Z0-9]{10}$/.test(value))
    .filter((value, index, list) => list.indexOf(value) === index);
}

function readAuthor() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(AUTHOR_KEY) ?? "";
}

function persistAuthor(value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTHOR_KEY, value);
}

type Props = {
  favorites?: AnalysisProjectFavorites;
  exportVisibleModules?: readonly ModuleKey[];
  exportIdentity?: ExportIdentity;
  canDeleteProjects?: boolean;
  onProjectDeleted?: (id: string) => void;
  market: string;
  draftAsins: string[];
  currentProjectId: string | null;
  kind?: ProjectKind;
  title?: string;
  description?: string;
  saveLabel?: string;
  loadLabel?: string;
  emptyHint?: string;
  suggestedMajorCategory?: string | null;
  suggestedCategoryLabel?: string | null;
  openInNewTab?: boolean;
  refreshingId?: string | null;
  buildLoadHref: (project: AnalysisProject) => string;
  onLoadProject?: (project: AnalysisProject) => void;
  onProjectSaved?: (project: AnalysisProject) => void;
  onRefreshKeywords?: (project: AnalysisProject) => void;
};

export function ProjectLibraryPage({
  favorites,
  exportVisibleModules,
  exportIdentity,
  canDeleteProjects = false,
  onProjectDeleted,
  market,
  draftAsins,
  currentProjectId,
  kind = "analysis",
  title = "项目收藏",
  description = "保存不同类目的竞品 ASIN 组合；数据存在团队服务器，局域网内成员均可查看与加载。",
  saveLabel = "保存为新项目",
  loadLabel = "加载项目",
  emptyHint = "还没有收藏项目。保存第一个对标池后，团队其他人也能在这里打开。",
  suggestedMajorCategory = null,
  suggestedCategoryLabel = null,
  openInNewTab = false,
  refreshingId = null,
  buildLoadHref,
  onLoadProject,
  onProjectSaved,
  onRefreshKeywords,
}: Props) {
  const [projects, setProjects] = useState<AnalysisProject[]>([]);
  const exportId = useId();
  // Keep the chosen metadata outside refreshing rows. This is a UI selection,
  // not the authoritative report snapshot that phase two will create.
  const [exportProject, setExportProject] = useState<AnalysisProject | null>(null);
  const [libraryView, setLibraryView] = useState<"favorites" | "history">("favorites");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [majorCategory, setMajorCategory] = useState("");
  const [categoryLabel, setCategoryLabel] = useState("");
  const [note, setNote] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [editMarketplace, setEditMarketplace] = useState("US");
  const [editAsinsText, setEditAsinsText] = useState("");
  const [majorFilter, setMajorFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [timeSort, setTimeSort] = useState<ProjectTimeSort>("updated_desc");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1, historyTotal: 0, favoritesTotal: 0, categories: [] as string[] });
  const requestRef = useRef<AbortController | null>(null);
  const favoritesVersion = favorites?.projectIds.join(",") ?? "";
  useEffect(() => {
    if (searchQuery === debouncedSearch) return;
    const timer = window.setTimeout(() => { setDebouncedSearch(searchQuery); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery, debouncedSearch]);
  const formRef = useRef<HTMLElement | null>(null);

  const copy = KIND_UI[kind];
  const isEditing = Boolean(editingId);

  const validDraftAsins = useMemo(
    () =>
      draftAsins
        .map(value => value.trim().toUpperCase())
        .filter(value => /^[A-Z0-9]{10}$/.test(value))
        .filter((value, index, list) => list.indexOf(value) === index),
    [draftAsins]
  );

  const formAsins = useMemo(
    () => (isEditing ? parseAsinInput(editAsinsText) : validDraftAsins),
    [isEditing, editAsinsText, validDraftAsins]
  );

  const majorCategoryOptions = useMemo(() => {
    const set = new Set<string>(AMAZON_MAJOR_CATEGORY_IDS);
    for (const category of pagination.categories) {
      const value = normalizeAmazonMajorCategory(category) ?? category.trim();
      if (value) set.add(value);
    }
    return Array.from(set);
  }, [pagination.categories]);

  const visibleTotal = kind === "analysis" && libraryView === "favorites" ? pagination.favoritesTotal : pagination.historyTotal;
  const hasActiveFilters = majorFilter !== "all" || Boolean(searchQuery.trim());

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ kind, page: String(page), pageSize: String(pageSize),
        sort: timeSort, search: debouncedSearch, category: majorFilter, view: kind === "analysis" ? libraryView : "history" });
      const response = await localAgentFetch(`/v1/local-data/projects?${query}`, { signal: controller.signal, cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "加载项目失败"));
      const parsed = LocalDataProjectsResponseSchema.parse(payload);
      if (!parsed.pagination) throw new Error("分页服务尚未就绪，请刷新重试");
      if (controller.signal.aborted) return;
      setProjects(parsed.projects);
      setPagination(parsed.pagination);
      if (parsed.pagination.page !== page) setPage(parsed.pagination.page);
    } catch (err) {
      if (!controller.signal.aborted) { setProjects([]); setError(err instanceof Error ? err.message : "加载项目失败"); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [kind, page, pageSize, timeSort, debouncedSearch, majorFilter, libraryView, favoritesVersion, favorites?.scope]);
  useEffect(() => () => requestRef.current?.abort(), [refresh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const url = new URL(window.location.href);
      if (url.searchParams.get("projectDeleted") === "1") {
        setNotice("已删除项目，团队历史和收藏列表已更新。");
        url.searchParams.delete("projectDeleted");
        window.history.replaceState(window.history.state, "", url);
      }
      setCreatedBy(readAuthor());
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || isEditing) return;
      if (suggestedMajorCategory && !majorCategory) {
        setMajorCategory(suggestedMajorCategory);
      }
      if (suggestedCategoryLabel && !categoryLabel) {
        setCategoryLabel(suggestedCategoryLabel);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isEditing, suggestedMajorCategory, suggestedCategoryLabel, majorCategory, categoryLabel]);

  const resetForm = (keepAuthor = true) => {
    setEditingId(null);
    setName("");
    setMajorCategory("");
    setCategoryLabel("");
    setNote("");
    setEditMarketplace(market);
    setEditAsinsText("");
    if (!keepAuthor) setCreatedBy("");
  };

  const beginEdit = (project: AnalysisProject) => {
    setEditingId(project.id);
    setName(project.name);
    setMajorCategory(project.majorCategory ?? "");
    setCategoryLabel(project.categoryLabel ?? "");
    setNote(project.note ?? "");
    setCreatedBy(project.createdBy ?? readAuthor());
    setEditMarketplace(project.marketplace || "US");
    setEditAsinsText(project.asins.join("\n"));
    setError(null);
    window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const saveProject = async () => {
    if (formAsins.length < 3) {
      setError(isEditing ? "请填写至少 3 个有效 ASIN" : "请先在 ASIN 输入区填写至少 3 个有效 ASIN");
      return;
    }
    if (formAsins.length > 10) {
      setError("最多保存 10 个 ASIN");
      return;
    }
    if (!name.trim()) {
      setError("请填写项目名称");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      persistAuthor(createdBy.trim());
      if (isEditing && editingId) {
        const response = await fetch(`/api/projects/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            name: name.trim(),
            majorCategory: majorCategory.trim(),
            categoryLabel: categoryLabel.trim(),
            marketplace: editMarketplace.trim().toUpperCase() || "US",
            asins: formAsins,
            note: note.trim(),
            createdBy: createdBy.trim(),
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "更新失败");
        onProjectSaved?.(payload.project);
        resetForm();
        await refresh();
      } else {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            name: name.trim(),
            majorCategory: majorCategory.trim(),
            categoryLabel: categoryLabel.trim(),
            marketplace: market,
            asins: formAsins,
            note: note.trim(),
            createdBy: createdBy.trim(),
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "保存失败");
        resetForm();
        if (kind === "analysis") setLibraryView("history");
        setPage(1);
        onProjectSaved?.(payload.project);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : isEditing ? "更新失败" : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const updateCurrentProjectAsins = async () => {
    if (!currentProjectId || validDraftAsins.length < 3) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${currentProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketplace: market,
          asins: validDraftAsins,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "更新失败");
      onProjectSaved?.(payload.project);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败");
    } finally {
      setSaving(false);
    }
  };

  const removeProject = async (id: string) => {
    if (deletingId || (kind === "analysis" && !canDeleteProjects)) return;
    if (!window.confirm("确定删除这个项目？这会从团队共享历史和收藏夹中移除项目，其他成员也将无法再打开。取消收藏请使用取消收藏按钮。")) return;
    setDeletingId(id);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? "删除失败");
      if (editingId === id) resetForm();
      setProjects(previous => previous.filter(project => project.id !== id));
      onProjectDeleted?.(id);
      setNotice("已删除项目，团队历史和收藏列表已更新。");
      void favorites?.refresh();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="project-library-page">
      {exportProject && favorites?.ready && favorites.projectIds.includes(exportProject.id) ? <ProjectExportDialog
        key={JSON.stringify([exportProject.id, exportIdentity?.sessionIdentity, exportVisibleModules])}
        project={exportProject} visibleModules={exportVisibleModules} identity={exportIdentity}
        onClose={() => {
          const triggerId = `${exportId}-${exportProject.id}`;
          setExportProject(null);
          // A refreshed row may have replaced the original focused button.
          requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
        }} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <section className="card page-intro">
        <div>
          <span className="status-chip project-status-chip">团队共享</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </section>

      <section ref={formRef} className={`card project-save-card${isEditing ? " editing" : ""}`}>
        <div className="project-section-head">
          <h3>{isEditing ? "编辑项目" : copy.saveTitle}</h3>
          <p>
            {isEditing
              ? "可修改名称、大类、品类、备注与 ASIN，保存后团队成员立即可见。"
              : copy.saveHint}
          </p>
        </div>
        <div className="project-form-grid">
          <label className="project-field">
            <span className="project-field-label">
              项目名称 <b>*</b>
            </span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="如：儿童三轮滑板车 · 美国站" />
          </label>
          <label className="project-field">
            <span className="project-field-label">亚马逊大类</span>
            <select value={majorCategory} onChange={e => setMajorCategory(e.target.value)}>
              <option value="">请选择亚马逊 BSR 大类</option>
              {AMAZON_MAJOR_CATEGORIES.map(option => (
                <option key={option.id} value={option.id}>
                  {amazonMajorCategoryLabel(option.id)}
                </option>
              ))}
              {majorCategory && !AMAZON_MAJOR_CATEGORY_IDS.includes(majorCategory) ? (
                <option value={majorCategory}>{majorCategory}（历史）</option>
              ) : null}
            </select>
          </label>
          <label className="project-field">
            <span className="project-field-label">类目 / 品类</span>
            <input value={categoryLabel} onChange={e => setCategoryLabel(e.target.value)} placeholder="如：Kick Scooters" />
          </label>
          <label className="project-field">
            <span className="project-field-label">创建人</span>
            <input value={createdBy} onChange={e => setCreatedBy(e.target.value)} placeholder="你的名字，便于团队识别" />
          </label>
          <label className="project-field">
            <span className="project-field-label">备注</span>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="可选：立项阶段、数据来源说明等" />
          </label>
          {isEditing ? (
            <label className="project-field">
              <span className="project-field-label">站点</span>
              <select value={editMarketplace} onChange={e => setEditMarketplace(e.target.value)}>
                {["US", "UK", "DE", "JP", "CA", "AU", "FR", "IT", "ES", "MX"].map(code => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {isEditing ? (
            <label className="project-field project-field-wide">
              <span className="project-field-label">
                ASIN 列表 <b>*</b>
              </span>
              <textarea
                value={editAsinsText}
                onChange={e => setEditAsinsText(e.target.value)}
                rows={3}
                placeholder="每行一个，或用逗号/空格分隔，3–10 个"
              />
            </label>
          ) : null}
        </div>
        <div className="project-panel-actions">
          {isEditing ? (
            <>
              <button type="button" className="primary-btn project-primary-btn" disabled={saving} onClick={saveProject}>
                {saving ? "保存中…" : "保存修改"}
              </button>
              <button type="button" className="ghost-btn" disabled={saving} onClick={() => resetForm()}>
                取消编辑
              </button>
            </>
          ) : (
            <>
              <button type="button" className="primary-btn project-primary-btn" disabled={saving} onClick={saveProject}>
                {saving ? "保存中…" : kind === "analysis" ? "保存为历史项目" : saveLabel}
              </button>
              {currentProjectId ? (
                <button type="button" className="ghost-btn" disabled={saving} onClick={updateCurrentProjectAsins}>
                  {copy.updateAsins}
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className="card project-list-card project-library-paged">
        <div className="project-list-head">
          <div className="project-section-head project-section-head-inline">
            <h3>{kind === "analysis" && libraryView === "history" ? "历史项目" : copy.listTitle}</h3>
            <p>
              {kind === "analysis" ? "团队共享；取消收藏只移除标记，项目及分析结果仍保留。" : copy.listHint}
              {` · 共 ${pagination.total} 个项目 · ${PROJECT_TIME_SORT_OPTIONS.find(option => option.value === timeSort)?.label}`}
            </p>
          </div>
          <button type="button" className="ghost-btn" onClick={() => { void refresh(); if (kind === "analysis") void favorites?.refresh(); }} disabled={loading || (kind === "analysis" && (favorites?.loading || favorites?.pending))}>
            刷新列表
          </button>
        </div>
        {kind === "analysis" ? <div className="project-major-chips" role="group" aria-label="项目列表范围">
          <button type="button" className={`project-major-chip${libraryView === "favorites" ? " active" : ""}`}
            aria-pressed={libraryView === "favorites"} onClick={() => { setLibraryView("favorites"); setPage(1); }}>
            已收藏（{pagination.favoritesTotal}）
          </button>
          <button type="button" className={`project-major-chip${libraryView === "history" ? " active" : ""}`}
            aria-pressed={libraryView === "history"} onClick={() => { setLibraryView("history"); setPage(1); }}>
            历史项目（{pagination.historyTotal}）
          </button>
        </div> : null}
        <div className="project-filter-bar">
          <label className="project-search-field">
            <span>模糊搜索</span>
            <input
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜项目名 / ASIN / 大类 / 品类 / 创建人 / 分析人 / 备注"
            />
          </label>
          <label className="project-filter-field">
            <span>亚马逊大类</span>
            <select value={majorFilter} onChange={e => { setMajorFilter(e.target.value); setPage(1); }}>
              <option value="all">全部大类</option>
              {AMAZON_MAJOR_CATEGORIES.map(option => (
                <option key={option.id} value={option.id}>
                  {amazonMajorCategoryLabel(option.id)}
                </option>
              ))}
              {majorCategoryOptions
                .filter(option => !AMAZON_MAJOR_CATEGORY_IDS.includes(option))
                .map(option => (
                  <option key={option} value={option}>
                    {option}（历史）
                  </option>
                ))}
              <option value="__none__">未填写大类目</option>
            </select>
          </label>
          <label className="project-filter-field">
            <span>时间排序</span>
            <select aria-label="时间排序" value={timeSort} onChange={event => { setTimeSort(event.target.value as ProjectTimeSort); setPage(1); }}>
              {PROJECT_TIME_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {hasActiveFilters ? (
            <button
              type="button"
              className="ghost-btn project-filter-clear"
              onClick={() => {
                setPage(1);
                setMajorFilter("all");
                setSearchQuery("");
              }}
            >
              清除筛选
            </button>
          ) : null}
        </div>
        {error ? <p className="project-panel-error">{error}</p> : null}
        {kind === "analysis" && favorites?.error ? <p role="alert" className="project-panel-error">{favorites.error}</p> : null}
        {loading ? <p className="project-panel-empty">加载中…</p> : null}
        {!loading && kind === "analysis" && libraryView === "favorites" && !favorites?.ready ? <p className="project-panel-empty">收藏列表尚未加载，请稍候或刷新重试。</p> : null}
        {!loading && !error && visibleTotal === 0 && (kind !== "analysis" || libraryView === "history" || favorites?.ready) ? (
          <p className="project-panel-empty">{kind === "analysis" ? (libraryView === "favorites" ? "尚未收藏项目，请在历史项目中点击收藏。" : "暂无历史项目，开始分析或保存项目后会出现在这里。") : emptyHint}</p>
        ) : null}
        {!loading && !error && visibleTotal > 0 && projects.length === 0 ? (
          <p className="project-panel-empty">没有匹配的项目，试试换个大类或搜索词。</p>
        ) : null}
        <div className="project-cards">
          {(loading ? [] : projects).map(project => (
            <article
              key={project.id}
              className={`project-card${project.id === currentProjectId ? " current" : ""}${
                project.id === editingId ? " editing" : ""
              }`}
            >
              <div className="project-card-main">
                <div className="project-card-heading">
                <h4 className="project-card-title" title={project.name}>{project.name}</h4>
                {project.id === currentProjectId ? <span className="project-current-label">当前项目</span> : null}
                <span className="project-card-market">{project.marketplace}</span>
                {project.majorCategory ? (
                  <span className="project-tag major" title={amazonMajorCategoryLabel(project.majorCategory)}>
                    {project.majorCategory}
                  </span>
                ) : null}
                {project.categoryLabel ? <span className="project-tag">{project.categoryLabel}</span> : null}
                </div>
                <div className="project-card-detail">
                <span className="project-card-asins" title={project.asins.join(" · ")}>
                  {project.asins.slice(0, 3).join(" · ")}{project.asins.length > 3 ? ` 等 ${project.asins.length} 个` : ""}
                </span>
                <span className="project-card-meta" title={[project.createdBy, project.note].filter(Boolean).join(" · ")}>
                  {project.asins.length} 个 ASIN
                  {project.createdBy ? ` · 创建人：${project.createdBy}` : ""}
                  {project.note ? ` · ${project.note}` : ""}
                </span>
                <span className="project-card-times">
                  {kind === "analysis" ? <span>最近分析人：{project.latestAnalystName || "未记录"}</span> : null}
                  <span>开始 <time dateTime={project.createdAt}>{formatDate(project.createdAt)}</time></span>
                  <span>{projectTimeValues(project).modified !== null
                    ? <>修改 <time dateTime={project.updatedAt}>{formatDate(project.updatedAt)}</time></>
                    : "未修改"}</span>
                </span>
              </div>
                </div>
              <div className="project-card-actions">
                <button type="button" className="ghost-btn" onClick={() => beginEdit(project)}>
                  {copy.editBtn}
                </button>
                {kind === "analysis" && favorites?.ready && !favorites.loading && !favorites.pending
                  && favorites.projectIds.includes(project.id) ? (
                  <ProjectExportButton id={`${exportId}-${project.id}`}
                    onClick={() => setExportProject({ ...project, asins: [...project.asins] })} />
                ) : null}
                {copy.refreshBtn && onRefreshKeywords ? (
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={refreshingId === project.id}
                    onClick={() => onRefreshKeywords(project)}
                  >
                    {refreshingId === project.id ? "刷新中…" : copy.refreshBtn}
                  </button>
                ) : null}
                <Link
                  href={buildLoadHref(project)}
                  className="primary-btn project-primary-btn"
                  target={openInNewTab ? "_blank" : undefined}
                  rel={openInNewTab ? "noopener noreferrer" : undefined}
                  onClick={() => {
                    if (!openInNewTab) onLoadProject?.(project);
                  }}
                >
                  {loadLabel}
                </Link>
                {kind === "analysis" ? <button type="button" className="ghost-btn"
                  disabled={!favorites?.ready || favorites.pending || favorites.loading}
                  aria-pressed={Boolean(favorites?.projectIds.includes(project.id))}
                  onClick={() => {
                    if (!favorites?.projectIds.includes(project.id) && !projectSegmentName(project)) {
                      beginEdit(project); setError("请先填写细分名称（项目名称）并保存，再收藏项目"); return;
                    }
                    void favorites?.setFavorite(project.id, !favorites.projectIds.includes(project.id));
                  }}>
                  {favorites?.pending ? "保存收藏中…" : favorites?.projectIds.includes(project.id) ? "取消收藏" : "☆ 收藏项目"}
                </button> : null}
                {(kind !== "analysis" || (libraryView === "history" && canDeleteProjects)) ? <button type="button" className="ghost-btn danger" disabled={deletingId !== null} onClick={() => void removeProject(project.id)}>
                  {deletingId === project.id ? "删除中…" : kind === "analysis" ? "删除项目" : "删除"}
                </button> : null}
              </div>
            </article>
          ))}
        </div>
        <nav className="project-pagination" aria-label="项目分页">
          <span role="status">{pagination.total ? `第 ${(pagination.page - 1) * pagination.pageSize + 1}–${Math.min(pagination.page * pagination.pageSize, pagination.total)} 条，共 ${pagination.total} 条` : "共 0 条"}</span>
          <label>每页 <select aria-label="每页项目数" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>
            {[10, 20, 50].map(size => <option key={size} value={size}>{size} 条</option>)}
          </select></label>
          <button type="button" className="ghost-btn" disabled={loading || page <= 1} onClick={() => setPage(1)}>首页</button>
          <button type="button" className="ghost-btn" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button>
          <span>{pagination.page} / {pagination.totalPages}</span>
          <button type="button" className="ghost-btn" disabled={loading || page >= pagination.totalPages} onClick={() => setPage(value => value + 1)}>下一页</button>
          <button type="button" className="ghost-btn" disabled={loading || page >= pagination.totalPages} onClick={() => setPage(pagination.totalPages)}>末页</button>
        </nav>
      </section>
    </div>
  );
}
