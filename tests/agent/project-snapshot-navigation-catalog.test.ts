import assert from "node:assert/strict";
import { test } from "node:test";

import {
  snapshotNavigationGroups,
  visibleSnapshotNavigation,
  resolveSnapshotSelection,
  type SnapshotPageId,
} from "../../app/project-export/snapshot-navigation-catalog";

test("catalog follows the published six groups and ten leaf labels in menu order", () => {
  assert.deepEqual(snapshotNavigationGroups.map(group => [group.id, group.label, group.sub]), [
    ["overview-group", "竞品概览", "参数 · 主辅图 · 变体"],
    ["voc-group", "VOC", "原始矩阵 · 洞察立项"],
    ["keywords-group", "关键词调研", "竞品词分析 · 洞察"],
    ["definition", "新品定义", "VOC×关键词 · 最终定义"],
    ["checklist", "立项前确认清单", "合规 · 专利 · 一票否决"],
    ["traffic", "竞品流量分析", "结构 · 月趋势 · 推广结论"],
  ]);
  assert.deepEqual(snapshotNavigationGroups.map(group => group.tone), ["teal", "red", "orange", "green", "red", "blue"]);
  assert.deepEqual(snapshotNavigationGroups.map(group => group.pages.map(page => [page.id, page.label, page.sub])), [
    [["overview", "竞品参数总览", "参数 · 趋势 · 变体"], ["images", "主辅图", "主图 · 辅图 · 图册对比"]],
    [["voc-summary", "竞品VOC 汇总", "七维 · 评论 · 综合"], ["voc-insight", "竞品 VOC 洞察", "摘要 · 好评 · 差评 · 未满足"], ["voc-positioning", "产品定义结论", "定位 · 三表合并 · 优化优先级"]],
    [["keyword-analysis", "竞品关键词分析", "含义分类 · 流量词对比"], ["keyword-insight", "关键词洞察", "开品结论 · 需求分层"]],
    [["definition", "新品定义", "VOC×关键词 · 最终定义"]],
    [["checklist", "立项前确认清单", "合规 · 专利 · 一票否决"]],
    [["traffic", "竞品流量分析", "结构 · 月趋势 · 推广结论"]],
  ]);
  assert.equal(snapshotNavigationGroups.reduce((count, group) => count + group.pages.length, 0), 10);
  assert.equal(snapshotNavigationGroups.some(group => /market|projects|admin/.test(group.id)), false);
});

test("overview includes variants by default, while both keyword pages share one source", () => {
  const allPages = snapshotNavigationGroups.reduce<SnapshotPageId[]>((ids, group) => {
    ids.push(...group.pages.map(page => page.id));
    return ids;
  }, []);
  assert.deepEqual(resolveSnapshotSelection({ pageIds: allPages, includeVariants: true }, undefined), {
    pageIds: allPages,
    moduleIds: ["competitor-overview", "variants-orders", "listing-images", "voc", "keywords", "definition", "checklist", "traffic"],
    includeVariants: true,
  });
  assert.deepEqual(resolveSnapshotSelection({ pageIds: ["keyword-insight", "keyword-analysis"], includeVariants: true }, ["keywords"]), {
    pageIds: ["keyword-analysis", "keyword-insight"], moduleIds: ["keywords"], includeVariants: false,
  });
});

test("one VOC leaf resolves without adjacent VOC pages", () => {
  assert.deepEqual(resolveSnapshotSelection({ pageIds: ["voc-insight"], includeVariants: true }, ["voc"]), {
    pageIds: ["voc-insight"], moduleIds: ["voc"], includeVariants: false,
  });
});

test("resolution sorts and deduplicates page IDs and source IDs", () => {
  assert.deepEqual(resolveSnapshotSelection({ pageIds: ["traffic", "images", "overview", "images", "voc-positioning", "voc-summary"], includeVariants: false }, undefined), {
    pageIds: ["overview", "images", "voc-summary", "voc-positioning", "traffic"],
    moduleIds: ["competitor-overview", "listing-images", "voc", "traffic"],
    includeVariants: false,
  });
});

test("visibility removes inaccessible groups and rejects their selected leaves", () => {
  assert.deepEqual(visibleSnapshotNavigation(["overview", "traffic"]).map(group => group.id), ["overview-group", "traffic"]);
  assert.deepEqual(visibleSnapshotNavigation([]), []);
  assert.throws(() => resolveSnapshotSelection({ pageIds: ["voc-summary"], includeVariants: false }, ["overview"]), /不可用|权限/);
  assert.throws(() => resolveSnapshotSelection({ pageIds: ["images"], includeVariants: false }, []), /不可用|权限/);
});

test("unknown IDs and malformed selections are rejected rather than silently replaced", () => {
  assert.throws(() => resolveSnapshotSelection({ pageIds: ["projects"] as never, includeVariants: false }, undefined), /未知/);
  assert.throws(() => resolveSnapshotSelection({ pageIds: "overview" as never, includeVariants: false }, undefined), /无效/);
  assert.throws(() => resolveSnapshotSelection({ pageIds: ["overview"], includeVariants: "yes" as never }, undefined), /无效/);
  assert.throws(() => resolveSnapshotSelection(null as never, undefined), /无效/);
});

test("empty selection stays empty and cannot activate the variants option", () => {
  assert.deepEqual(resolveSnapshotSelection({ pageIds: [], includeVariants: true }, undefined), {
    pageIds: [], moduleIds: [], includeVariants: false,
  });
});
