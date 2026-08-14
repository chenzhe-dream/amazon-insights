import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import {
  checklistSourceLabels,
  parseTableCellOptions,
  type LaunchChecklistGroup,
  type LaunchChecklistResearchContext,
  type LaunchChecklistStructuredTable,
} from "./launch-checklist";

export type ChecklistSectionLayout = {
  section: string;
  display: string;
};

export type ChecklistExportInput = {
  version: string;
  viewLabel?: string;
  sectionLayout?: ChecklistSectionLayout[];
  research: LaunchChecklistResearchContext;
  groups: LaunchChecklistGroup[];
  manualValues: Record<string, string>;
  tableValues: Record<string, string>;
  checked: Record<string, boolean>;
};

function resolveExportSections(input: ChecklistExportInput) {
  const layout =
    input.sectionLayout ??
    Array.from(new Set(input.groups.map(group => group.section))).map(section => ({ section, display: section }));

  return layout
    .map(entry => ({
      ...entry,
      groups: input.groups.filter(group => group.section === entry.section),
    }))
    .filter(entry => entry.groups.length > 0);
}

function formatSectionHeading(display: string) {
  return `第${display}部分`;
}

function appendGroupExportBlocks(
  target: Array<Paragraph | Table>,
  group: LaunchChecklistGroup,
  input: ChecklistExportInput,
) {
  target.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun(group.title)],
      spacing: { before: 120, after: 80 },
    }),
  );

  if (group.description) {
    target.push(
      new Paragraph({
        children: [new TextRun({ text: group.description, italics: true, color: "718095" })],
        spacing: { after: 80 },
      }),
    );
  }

  if (group.competitorTable) {
    target.push(...buildTableBlocks(group.competitorTable, input, "竞品快照（系统抓取）"));
  }

  if (group.structuredTable) {
    target.push(...buildTableBlocks(group.structuredTable, input));
  }

  target.push(...buildEntryParagraph(group, input));
}

function resolveTableCellValue(
  cell: LaunchChecklistStructuredTable["rows"][number][number],
  input: ChecklistExportInput,
) {
  const manual = input.tableValues[cell.key];
  if (manual !== undefined && manual !== "") return manual;
  if (parseTableCellOptions(cell.text)) return "";
  if (cell.text) return cell.text;
  return input.manualValues[cell.key] ?? "";
}

function buildTableBlocks(
  table: LaunchChecklistStructuredTable,
  input: ChecklistExportInput,
  label?: string,
): Array<Paragraph | Table> {
  const blocks: Array<Paragraph | Table> = [];
  if (label) {
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: label, bold: true })],
        spacing: { before: 120, after: 80 },
      }),
    );
  }

  blocks.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: table.headers.map(
            header =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: header, bold: true })],
                  }),
                ],
                shading: { fill: "F3F6FA" },
              }),
          ),
        }),
        ...table.rows.map(
          row =>
            new TableRow({
              children: row.map(cell => {
                const value =
                  cell.source === "auto"
                    ? resolveTableCellValue(cell, input) || cell.text || "—"
                    : resolveTableCellValue(cell, input) || "—";
                return new TableCell({
                  children: [new Paragraph({ children: [new TextRun(value)] })],
                });
              }),
            }),
        ),
      ],
    }),
  );

  return blocks;
}

function buildEntryParagraph(group: LaunchChecklistGroup, input: ChecklistExportInput) {
  const entries =
    group.entries ??
    group.items.map((label, index) => ({
      id: `${group.id}-${index}`,
      label,
      source: "manual" as const,
    }));

  return entries.map(item => {
    const tag = checklistSourceLabels[item.source];
    const value = input.manualValues[item.id] ?? item.autoValue ?? "";
    const isAuto = item.source === "auto";
    const mark = isAuto ? "·" : input.checked[`${group.id}::${item.label}`] ? "☑" : "☐";
    const suffix =
      item.source === "check" || item.source === "verify" || item.source === "auto"
        ? value
          ? ` → ${value}`
          : ""
        : value
          ? `：${value}`
          : "";

    return new Paragraph({
      children: [
        new TextRun({ text: `${mark} ` }),
        ...(isAuto ? [new TextRun({ text: `[${tag}] `, bold: true, color: "43566D" })] : []),
        new TextRun({ text: `${item.label}${suffix}` }),
      ],
      spacing: { after: 60 },
    });
  });
}

export function exportChecklistMarkdown(input: ChecklistExportInput): string {
  const viewLabel = input.viewLabel ? ` · ${input.viewLabel}` : "";
  const lines: string[] = [
    `# 产品立项前确认清单 ${input.version}${viewLabel}`,
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

  for (const section of resolveExportSections(input)) {
    lines.push(`## ${formatSectionHeading(section.display)}`, "");

    for (const group of section.groups) {
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
          const cells = row.map(cell => resolveTableCellValue(cell, input) || "—");
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
        const isAuto = item.source === "auto";
        const checked = input.checked[`${group.id}::${item.label}`] ? "x" : " ";
        const prefix = isAuto ? `- [${tag}]` : `- [${checked}]`;
        if (item.source === "check" || item.source === "verify" || item.source === "auto") {
          lines.push(`${prefix} ${item.label}${value ? ` → ${value}` : ""}`);
        } else {
          lines.push(`${prefix} ${item.label}${value ? `：${value}` : ""}`);
        }
      });
      lines.push("");
    }
  }

  return lines.join("\n");
}

export async function exportChecklistDocx(input: ChecklistExportInput): Promise<Blob> {
  const viewLabel = input.viewLabel ? ` · ${input.viewLabel}` : "";
  const exportSections = resolveExportSections(input);
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: `产品立项前确认清单 ${input.version}${viewLabel}`, bold: true })],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `导出时间：${new Date().toLocaleString("zh-CN")}`,
          color: "66758A",
          italics: true,
        }),
      ],
      spacing: { after: 200 },
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("调研数据摘要")],
    }),
    ...[
      `细分类目：${input.research.categoryNode}`,
      `识别品类：${input.research.verticalLabel}`,
      `对标 ASIN：${input.research.asinList}`,
      `售价区间：${input.research.priceBand}`,
      `样本月销：${input.research.sampleSales}`,
      `VOC：关注 ${input.research.topAttention} · 差评 ${input.research.topNegative} · 未满足 ${input.research.topUnmet}`,
      `首要机会：${input.research.topOpportunity}`,
      `建议目标价：${input.research.targetPrice}`,
    ].map(
      line =>
        new Paragraph({
          children: [new TextRun(line)],
          spacing: { after: 40 },
        }),
    ),
  ];

  exportSections.forEach((section, index) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun(formatSectionHeading(section.display))],
        spacing: { before: 240, after: 120 },
        pageBreakBefore: index > 0,
      }),
    );

    for (const group of section.groups) {
      appendGroupExportBlocks(children, group, input);
    }
  });

  const document = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 720,
              right: 720,
              bottom: 720,
              left: 720,
            },
          },
        },
        children,
      },
    ],
    styles: {
      default: {
        document: {
          run: {
            font: "Microsoft YaHei",
            size: 22,
          },
        },
      },
    },
  });

  return Packer.toBlob(document);
}

export function downloadBlobFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadTextFile(filename: string, content: string, mime = "text/markdown;charset=utf-8") {
  downloadBlobFile(filename, new Blob([content], { type: mime }));
}
