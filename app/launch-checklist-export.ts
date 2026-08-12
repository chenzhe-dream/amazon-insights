import {
  checklistSourceLabels,
  parseTableCellOptions,
  type LaunchChecklistGroup,
  type LaunchChecklistResearchContext,
} from "./launch-checklist";

export function exportChecklistMarkdown(input: {
  version: string;
  research: LaunchChecklistResearchContext;
  groups: LaunchChecklistGroup[];
  manualValues: Record<string, string>;
  tableValues: Record<string, string>;
  checked: Record<string, boolean>;
}): string {
  const lines: string[] = [
    `# 产品立项前确认清单 ${input.version}`,
    "",
    `> 导出时间：${new Date().toLocaleString("zh-CN")}`,
    "",
    "## 调研数据摘要",
    "",
    `- 细分类目：${input.research.categoryNode}`,
    `- 识别品类：${input.research.verticalLabel}`,
    `- 对标 ASIN：${input.research.asinList}`,
    `- 售价区间：${input.research.priceBand}`,
    `- 样本月销：${input.research.sampleSales}`,
    `- VOC：关注 ${input.research.topAttention} · 差评 ${input.research.topNegative} · 未满足 ${input.research.topUnmet}`,
    `- 首要机会：${input.research.topOpportunity}`,
    `- 建议目标价：${input.research.targetPrice}`,
    "",
  ];

  let currentSection = "";
  for (const group of input.groups) {
    if (group.section !== currentSection) {
      currentSection = group.section;
      lines.push(`## 第${currentSection}部分`, "");
    }
    lines.push(`### ${group.title}`, "");
    if (group.description) lines.push(`_${group.description}_`, "");

    if (group.competitorTable) {
      lines.push("", "**竞品快照（系统抓取）**", "");
      lines.push(`| ${group.competitorTable.headers.join(" | ")} |`);
      lines.push(`| ${group.competitorTable.headers.map(() => "---").join(" | ")} |`);
      group.competitorTable.rows.forEach(row => {
        lines.push(`| ${row.map(cell => cell.text || "—").join(" | ")} |`);
      });
      lines.push("");
    }

    if (group.structuredTable) {
      lines.push(`| ${group.structuredTable.headers.join(" | ")} |`);
      lines.push(`| ${group.structuredTable.headers.map(() => "---").join(" | ")} |`);
      group.structuredTable.rows.forEach(row => {
        const cells = row.map(cell => {
          const manual = input.tableValues[cell.key];
          if (manual !== undefined && manual !== "") return manual;
          if (parseTableCellOptions(cell.text)) return "";
          if (cell.text) return cell.text;
          return input.manualValues[cell.key] ?? "";
        });
        lines.push(`| ${cells.join(" | ")} |`);
      });
      lines.push("");
    }

    const entries =
      group.entries ??
      group.items.map((label, index) => ({
        id: `${group.id}-${index}`,
        label,
        source: "manual" as const,
      }));

    entries.forEach(item => {
      const tag = checklistSourceLabels[item.source];
      const value = input.manualValues[item.id] ?? item.autoValue ?? "";
      const checked = input.checked[`${group.id}::${item.label}`] ? "x" : " ";
      if (item.source === "check" || item.source === "verify" || item.source === "auto") {
        lines.push(`- [${checked}] **${tag}** ${item.label}${value ? ` → ${value}` : ""}`);
      } else {
        lines.push(`- [${checked}] **${tag}** ${item.label}${value ? `：${value}` : ""}`);
      }
    });
    lines.push("");
  }

  return lines.join("\n");
}

export function downloadTextFile(filename: string, content: string, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
