type KeywordRecordPeriod = {
  queryWindow?: {time_type:string;time_value:string;listingSearch:boolean} | null;
  currentEmpty?: {terminalReason:string} | null;
};

export function sifKeywordRecordPeriod(record: KeywordRecordPeriod | null | undefined): string | null {
  const window = record?.queryWindow;
  if (!window) return null;
  const site = window.listingSearch ? "站内搜索" : "全部搜索";
  if (window.time_type === "month" && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(window.time_value))
    return `历史 ${window.time_value.slice(0,7)} · ${site}${record?.currentEmpty?.terminalReason === "valid-empty" ? "（近30天无词）" : ""}`;
  if (window.time_type === "lately" && /^\d+$/.test(window.time_value)) return `近${window.time_value}天 · ${site}`;
  return `${window.time_type} ${window.time_value} · ${site}`;
}

export function sifKeywordCohortPeriod(records: readonly (KeywordRecordPeriod & {status:string;keywords:readonly unknown[]} | undefined)[]): string | null {
  const periods = new Set(records.filter(record => record?.status === "ready" && record.keywords.length)
    .map(record => sifKeywordRecordPeriod(record) ?? "来源周期未记录"));
  return formatSifKeywordPeriods(periods);
}

export function formatSifKeywordPeriods(periods: ReadonlySet<string>): string | null {
  return periods.size === 1 ? [...periods][0] : periods.size > 1 ? `混合来源周期：${[...periods].join("；")}` : null;
}
