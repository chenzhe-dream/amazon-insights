function safeFilePart(value: string, maxLength: number, fallback: string): string {
  const cleaned = Array.from(value)
    .filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127 && !'<>:"/\\|?*'.includes(char))
    .join("").trim().replace(/[. ]+$/g, "");
  let result = "";
  for (const char of cleaned) {
    if (result.length + char.length > maxLength) break;
    result += char;
  }
  result = result.replace(/[. ]+$/g, "") || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `_${result}` : result;
}

export function buildExportFileName(projectName: string, marketplace: string, capturedAt: string): string {
  const date = new Date(capturedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("无效的快照时间");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (key: string) => parts.find(item => item.type === key)!.value;
  const stamp = `${part("year")}${part("month")}${part("day")}-${part("hour")}${part("minute")}${part("second")}`;
  return `${safeFilePart(projectName, 72, "项目")}_${safeFilePart(marketplace, 12, "站点")}_快照_${stamp}.html`;
}

/** Initiates a browser download; completion on disk cannot be observed here. */
export function downloadExportHtml(html: string, fileName: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the object URL alive until the browser has consumed the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
