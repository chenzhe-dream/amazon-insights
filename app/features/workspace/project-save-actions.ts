"use client";

import { type AnalysisProject } from "../projects/project-library-panel";
import { inferAmazonMajorCategory } from "../../amazon-major-categories";
import { buildInputSlots } from "../projects/workspace-navigation";
import type { useWorkspaceInput } from "./workspace-input";
import type { useProjectState } from "./project-state";
import type { useWorkspaceVocSources } from "./workspace-voc-sources";
import type { createProjectApplication } from "./project-application";
import type { createAnalysisWorkspace } from "./workspace-analysis-actions";

type createProjectSaveActionsInputs = Pick<ReturnType<typeof useWorkspaceInput>, "activeAsins" | "setMessage" | "market" | "inputs" | "setActiveAsins" | "setInputs">
  & Pick<ReturnType<typeof useProjectState>, "setSavingKeywordCompare" | "setSavingTrafficPromo" | "setSavingChecklist">
  & Pick<ReturnType<typeof useWorkspaceVocSources>, "products">
  & Pick<ReturnType<typeof createProjectApplication>, "applyProject">
  & Pick<ReturnType<typeof createAnalysisWorkspace>, "persistAsins">;

export function createProjectSaveActions({
    activeAsins, setMessage, setSavingKeywordCompare, products, market, applyProject, inputs, setActiveAsins, setInputs,
    persistAsins, setSavingTrafficPromo, setSavingChecklist,
  }: createProjectSaveActionsInputs) {
  const saveKeywordCompareProject = async () => {
    if (activeAsins.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到流量词对比");
      return;
    }
    setSavingKeywordCompare(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "竞品关键词";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "keyword-compare",
          name: `${categoryHint} · 流量词对比 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自竞品关键词分析 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「流量词对比」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到流量词对比失败");
    } finally {
      setSavingKeywordCompare(false);
    }
  };

  const saveTrafficPromoProject = async () => {
    const values = inputs.map(v => v.trim().toUpperCase()).filter(Boolean);
    if (values.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到推广能力分析");
      return;
    }
    const invalid = values.find(v => !/^[A-Z0-9]{10}$/.test(v));
    if (invalid) {
      setMessage(`${invalid} 格式不正确，ASIN 应为 10 位字母或数字`);
      return;
    }
    if (new Set(values).size !== values.length) {
      setMessage("请勿重复输入相同 ASIN");
      return;
    }
    setActiveAsins(values);
    setInputs(buildInputSlots(values));
    persistAsins(values);
    setSavingTrafficPromo(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "竞品流量";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "traffic-promo",
          name: `${categoryHint} · 推广能力分析 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: values,
          note: `来自竞品流量分析 · ${values.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「竞品推广能力分析」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到推广能力分析失败");
    } finally {
      setSavingTrafficPromo(false);
    }
  };

  const saveChecklistProject = async () => {
    if (activeAsins.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到项目确认清单");
      return;
    }
    setSavingChecklist(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "立项确认";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "checklist",
          name: `${categoryHint} · 立项确认清单 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自立项前确认清单 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「项目确认清单」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到项目确认清单失败");
    } finally {
      setSavingChecklist(false);
    }
  };

  return { saveKeywordCompareProject, saveTrafficPromoProject, saveChecklistProject };
}
