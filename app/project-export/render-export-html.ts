import type { ExportBlock, ExportCell, PreparedExportContent } from "./export-contracts";
import { EXPORT_HTML_STYLES } from "./export-html-styles";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  // IPv6 literals are deliberately omitted: image sources use public DNS names.
  if (host.includes(":") || !host.includes(".") || /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)));
  }
  return true;
}

function safeOnlineUrl(value: string | undefined, unwrapImage = false): string | null {
  if (!value) return null;
  let candidate = value.trim();
  try {
    if (unwrapImage && candidate.startsWith("/api/amazon-image?")) {
      const proxy = new URL(candidate, "https://export.invalid");
      const entries = [...proxy.searchParams.entries()];
      if (proxy.pathname !== "/api/amazon-image" || proxy.hash || entries.length !== 1 || entries[0][0] !== "u") return null;
      candidate = entries[0][1];
    }
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || !isPublicHost(url.hostname) || /^\/api(?:\/|$)/i.test(url.pathname)) return null;
    // Shareable URLs must not carry session or signed-access credentials.
    const credentialKey = /(?:token|auth|credential|signature|session|cookie|api[-_]?key|secret|password)/i;
    if ([...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(key => credentialKey.test(key))) return null;
    return url.href;
  } catch {
    return null;
  }
}

function link(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(text)}</a>`;
}

function renderCell(cell: ExportCell): string {
  const href = safeOnlineUrl(cell.href);
  let html = href ? link(href, cell.text) : escapeHtml(cell.text);
  if (cell.imageUrl) {
    const image = safeOnlineUrl(cell.imageUrl, true);
    html += image
      ? `<figure><img src="${escapeHtml(image)}" alt="${escapeHtml(cell.text)}" referrerpolicy="no-referrer"><figcaption>${link(image, "查看原图")}</figcaption></figure>`
      : '<p class="missing">无可分享图片地址</p>';
  }
  return html;
}

function renderTable(columns: readonly string[], rows: readonly (readonly ExportCell[])[]): string {
  return `<div class="table-wrap"><table><thead><tr>${columns.map(column => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderCell(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

const CHART_COLORS = ["#7964e5", "#3688ca", "#238c83", "#c0782f", "#b95482", "#64748b"];
function renderChart(block: Extract<ExportBlock, { kind: "chart" }>): string {
  const count = Math.max(block.labels.length, 0, ...block.series.map(series => series.values.length));
  const values = block.series.flatMap(series => series.values.filter((value): value is number => value !== null && Number.isFinite(value)));
  const title = `<h3>${escapeHtml(block.title)}</h3>`;
  if (!block.series.length || !count) return `${title}<p class="missing">暂无可用图表数据</p>`;
  const rows: ExportCell[][] = Array.from({ length: count }, (_, index) => [
    { text: block.labels[index] ?? `数据点 ${index + 1}` },
    ...block.series.map(series => ({ text: series.values[index] != null && Number.isFinite(series.values[index]) ? String(series.values[index]) : "—" })),
  ]);
  const table = renderTable(["时间 / 标签", ...block.series.map(series => series.label)], rows);
  if (!values.length) return `${title}<p class="missing">暂无可用图表数据</p>${table}`;
  // Normalize before computing the range to keep large finite values finite.
  const scale = values.reduce((max, value) => Math.max(max, Math.abs(value)), 1);
  const minimum = values.reduce((min, value) => Math.min(min, value / scale), Infinity);
  const maximum = values.reduce((max, value) => Math.max(max, value / scale), -Infinity);
  const range = maximum - minimum || 1;
  const x = (index: number) => count === 1 ? 480 : 64 + index * 840 / (count - 1);
  const y = (value: number) => 210 - ((value / scale - minimum) / range) * 170;
  const marks = block.series.map((series, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
    const lines: string[] = [];
    const dots: string[] = [];
    let run: string[] = [];
    const flush = () => { if (run.length > 1) lines.push(`<polyline points="${run.join(" ")}" fill="none" stroke="${color}" stroke-width="2"/>`); run = []; };
    for (let index = 0; index < count; index++) {
      const value = series.values[index];
      if (value == null || !Number.isFinite(value)) { flush(); continue; }
      const cx = x(index).toFixed(2), cy = y(value).toFixed(2);
      run.push(`${cx},${cy}`);
      dots.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${color}"><title>${escapeHtml(`${series.label} · ${rows[index][0].text}: ${value}`)}</title></circle>`);
    }
    flush();
    return lines.join("") + dots.join("");
  }).join("");
  const legend = `<p class="legend">${block.series.map((series, index) => `<span style="border-color:${CHART_COLORS[index % CHART_COLORS.length]}">${escapeHtml(series.label)}</span>`).join("")}</p>`;
  return `${title}${legend}<svg xmlns="http://www.w3.org/2000/svg" class="chart" viewBox="0 0 960 260" role="img" aria-label="${escapeHtml(block.title)}"><title>${escapeHtml(block.title)}（完整数值见下表）</title><path d="M64 28V210H904" fill="none" stroke="#cbd5e1"/><text x="60" y="20" fill="#657b9a" font-size="12">${escapeHtml(String(maximum * scale))}</text><text x="60" y="230" fill="#657b9a" font-size="12">${escapeHtml(rows[0][0].text)}</text><text x="904" y="250" text-anchor="end" fill="#657b9a" font-size="12">${escapeHtml(rows[count - 1][0].text)}</text>${marks}</svg><p class="note">缺失值以 — 表示，折线在缺失处断开；下表保留全部标签和数值。</p>${table}`;
}

function renderBlock(block: ExportBlock): string {
  if (block.kind === "text") return `<p class="text">${escapeHtml(block.text)}</p>`;
  if (block.kind === "chart") return renderChart(block);
  return `<h3>${escapeHtml(block.title)}</h3>${renderTable(block.columns, block.rows)}`;
}

/** Pure renderer: only the selected prepared content is ever serialized. */
export function renderExportHtml(content: PreparedExportContent): string {
  const time = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(content.capturedAt));
  const sections = content.sections.map(section => `<section id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2>${section.status === "missing" ? '<p class="missing">暂无已生成结果</p>' : ""}${section.blocks.map(block => `<div class="block">${renderBlock(block)}</div>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'"><meta name="referrer" content="no-referrer"><title>${escapeHtml(content.project.name)} · 项目快照</title><style>${EXPORT_HTML_STYLES}</style></head><body><main><header><h1>${escapeHtml(content.project.name)}</h1><p class="meta">站点：${escapeHtml(content.project.marketplace)} · ASIN：${content.project.asins.map(escapeHtml).join("、")}</p><p class="meta">快照准备完成时间：${escapeHtml(time)}（北京时间）</p><p class="meta">数据来源：${escapeHtml(content.sourceLabel)}</p><p class="notice">正文、表格、图表和样式已固定。图片通过在线地址读取，可能变化或失效；查看原图需要网络连接。</p></header>${sections}</main></body></html>`;
}
