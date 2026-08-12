"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AnalysisProject = {
  id: string;
  name: string;
  majorCategory: string | null;
  categoryLabel: string | null;
  marketplace: string;
  asins: string[];
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

const AUTHOR_KEY = "amz-lens-project-author";

/** 亚马逊大类预设，保存与筛选共用，保证可筛 */
export const AMAZON_MAJOR_CATEGORIES = [
  "户外运动",
  "灯具",
  "家居",
  "家具",
  "玩具",
  "园艺",
  "美妆",
  "母婴",
  "宠物",
  "厨房",
  "电子",
  "汽车",
  "服装",
  "其他",
] as const;

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function parseAsinInput(raw: string) {
  return raw
    .toUpperCase()
    .split(/[\s,，、;；|/]+/)
    .map(value => value.trim())
    .filter(value => /^[A-Z0-9]{10}$/.test(value))
    .filter((value, index, list) => list.indexOf(value) === index);
}

function projectMatchesQuery(project: AnalysisProject, query: string) {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  const haystack = normalizeSearchText(
    [
      project.name,
      project.majorCategory ?? "",
      project.categoryLabel ?? "",
      project.note ?? "",
      project.createdBy ?? "",
      project.marketplace,
      project.asins.join(" "),
    ].join(" ")
  );
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/[\s,，、/|]+/)
    .map(token => token.replace(/\s+/g, ""))
    .filter(Boolean);
  if (tokens.length <= 1) return haystack.includes(needle);
  return tokens.every(token => haystack.includes(token));
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
  market: string;
  draftAsins: string[];
  currentProjectId: string | null;
  buildLoadHref: (project: AnalysisProject) => string;
  onLoadProject?: (project: AnalysisProject) => void;
  onProjectSaved?: (project: AnalysisProject) => void;
};

export function ProjectLibraryPage({
  market,
  draftAsins,
  currentProjectId,
  buildLoadHref,
  onLoadProject,
  onProjectSaved,
}: Props) {
  const [projects, setProjects] = useState<AnalysisProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const formRef = useRef<HTMLElement | null>(null);

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
    const set = new Set<string>(AMAZON_MAJOR_CATEGORIES);
    for (const project of projects) {
      const value = project.majorCategory?.trim();
      if (value) set.add(value);
    }
    return Array.from(set);
  }, [projects]);

  const filteredProjects = useMemo(() => {
    return projects.filter(project => {
      if (majorFilter === "__none__" && project.majorCategory) return false;
      if (majorFilter !== "all" && majorFilter !== "__none__" && project.majorCategory !== majorFilter) {
        return false;
      }
      return projectMatchesQuery(project, searchQuery);
    });
  }, [projects, majorFilter, searchQuery]);

  const hasActiveFilters = majorFilter !== "all" || Boolean(searchQuery.trim());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/projects");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "加载项目失败");
      setProjects(payload.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载项目失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setCreatedBy(readAuthor());
    refresh();
  }, [refresh]);

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
    if (!window.confirm("确定删除这个项目？团队其他人也将无法再从收藏夹打开。")) return;
    setError(null);
    try {
      const response = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "删除失败");
      if (editingId === id) resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  };

  return (
    <div className="project-library-page">
      <section className="card page-intro">
        <div>
          <span className="status-chip project-status-chip">团队共享</span>
          <h2>项目收藏夹</h2>
          <p>保存不同类目的竞品 ASIN 组合；数据存在团队服务器，局域网内成员均可查看与加载。</p>
        </div>
      </section>

      <section ref={formRef} className={`card project-save-card${isEditing ? " editing" : ""}`}>
        <div className="project-section-head">
          <h3>{isEditing ? "编辑收藏项目" : "保存当前对标池"}</h3>
          <p>
            {isEditing
              ? "可修改名称、大类、品类、备注与 ASIN，保存后团队成员立即可见。"
              : "将当前 ASIN 组合保存为团队共享项目，便于下次快速加载。"}
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
            <span className="project-field-label">大类目</span>
            <select value={majorCategory} onChange={e => setMajorCategory(e.target.value)}>
              <option value="">请选择亚马逊大类</option>
              {AMAZON_MAJOR_CATEGORIES.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {majorCategory && !(AMAZON_MAJOR_CATEGORIES as readonly string[]).includes(majorCategory) ? (
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
                {saving ? "保存中…" : "保存为新项目"}
              </button>
              {currentProjectId ? (
                <button type="button" className="ghost-btn" disabled={saving} onClick={updateCurrentProjectAsins}>
                  更新当前项目 ASIN
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className="card project-list-card">
        <div className="project-list-head">
          <div className="project-section-head project-section-head-inline">
            <h3>已收藏项目</h3>
            <p>
              团队共享，点击加载即可切换对标 ASIN 组合。
              {projects.length > 0 ? ` · 显示 ${filteredProjects.length}/${projects.length}` : ""}
            </p>
          </div>
          <button type="button" className="ghost-btn" onClick={refresh} disabled={loading}>
            刷新
          </button>
        </div>
        <div className="project-filter-bar">
          <label className="project-search-field">
            <span>模糊搜索</span>
            <input
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜项目名 / ASIN / 大类 / 品类 / 创建人 / 备注"
            />
          </label>
          <label className="project-filter-field">
            <span>亚马逊大类</span>
            <select value={majorFilter} onChange={e => setMajorFilter(e.target.value)}>
              <option value="all">全部大类</option>
              {AMAZON_MAJOR_CATEGORIES.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {majorCategoryOptions
                .filter(option => !(AMAZON_MAJOR_CATEGORIES as readonly string[]).includes(option))
                .map(option => (
                  <option key={option} value={option}>
                    {option}（历史）
                  </option>
                ))}
              <option value="__none__">未填写大类目</option>
            </select>
          </label>
          {hasActiveFilters ? (
            <button
              type="button"
              className="ghost-btn project-filter-clear"
              onClick={() => {
                setMajorFilter("all");
                setSearchQuery("");
              }}
            >
              清除筛选
            </button>
          ) : null}
        </div>
        <div className="project-major-chips" role="tablist" aria-label="按亚马逊大类快速筛选">
          <button
            type="button"
            className={`project-major-chip${majorFilter === "all" ? " active" : ""}`}
            onClick={() => setMajorFilter("all")}
          >
            全部
          </button>
          {AMAZON_MAJOR_CATEGORIES.map(option => (
            <button
              key={option}
              type="button"
              className={`project-major-chip${majorFilter === option ? " active" : ""}`}
              onClick={() => setMajorFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
        {error ? <p className="project-panel-error">{error}</p> : null}
        {loading ? <p className="project-panel-empty">加载中…</p> : null}
        {!loading && projects.length === 0 ? (
          <p className="project-panel-empty">还没有收藏项目。保存第一个对标池后，团队其他人也能在这里打开。</p>
        ) : null}
        {!loading && projects.length > 0 && filteredProjects.length === 0 ? (
          <p className="project-panel-empty">没有匹配的项目，试试换个大类或搜索词。</p>
        ) : null}
        <div className="project-cards">
          {filteredProjects.map(project => (
            <article
              key={project.id}
              className={`project-card${project.id === currentProjectId ? " current" : ""}${
                project.id === editingId ? " editing" : ""
              }`}
            >
              <div className="project-card-main">
                <h4 className="project-card-title">{project.name}</h4>
                <span className="project-card-market">{project.marketplace}</span>
                {project.majorCategory ? <span className="project-tag major">{project.majorCategory}</span> : null}
                {project.categoryLabel ? <span className="project-tag">{project.categoryLabel}</span> : null}
                <span className="project-card-asins" title={project.asins.join(" · ")}>
                  {project.asins.join(" · ")}
                </span>
                <span className="project-card-meta">
                  {project.asins.length} 个 ASIN
                  {project.createdBy ? ` · ${project.createdBy}` : ""}
                  {" · "}
                  {formatDate(project.updatedAt)}
                  {project.note ? ` · ${project.note}` : ""}
                </span>
              </div>
              <div className="project-card-actions">
                <button type="button" className="ghost-btn" onClick={() => beginEdit(project)}>
                  编辑
                </button>
                <Link
                  href={buildLoadHref(project)}
                  className="primary-btn project-primary-btn"
                  onClick={() => onLoadProject?.(project)}
                >
                  加载项目
                </Link>
                <button type="button" className="ghost-btn danger" onClick={() => removeProject(project.id)}>
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
