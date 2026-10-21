import { formatProviderDiagnosticLine } from "./provider-diagnostics.mjs";
import fs from "node:fs";

/** 是否强制刷新（忽略缓存，重新调用 MCP） */
export function isForceRefresh() {
  if (isRepairIncomplete()) return false;
  if (process.env.FORCE_REFRESH === "1" || process.env.FORCE_REFRESH === "true") return true;
  return process.argv.includes("--force");
}

/** 缓存最大有效天数；0 表示永不过期（除非 --force） */
export function cacheMaxAgeDays() {
  const value = Number.parseInt(process.env.REFRESH_STALE_DAYS ?? "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseFetchedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isCacheStale(record, maxAgeDays) {
  if (!maxAgeDays) return false;
  const fetchedAt = parseFetchedAt(record?.fetchedAt);
  if (!fetchedAt) return true;
  const ageMs = Date.now() - fetchedAt.getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

/** 已有 ready 缓存且未强制刷新、未过期 → 跳过 MCP */
export function shouldUseCachedRecord(record, options = {}) {
  const forceRefresh = options.forceRefresh ?? isForceRefresh();
  const maxAgeDays = options.maxAgeDays ?? cacheMaxAgeDays();
  if (!isRepairIncomplete() && forceRefresh) return false;
  if (!record || record.status !== "ready") return false;
  if (!isRepairIncomplete() && isCacheStale(record, maxAgeDays)) return false;
  return true;
}

/** 从生成的 .ts 数据文件中读取 Record<string, T> 导出 */
export function readCachedDataExport(filePath, exportName) {
  if (!fs.existsSync(filePath)) return {};
  const source = fs.readFileSync(filePath, "utf8");
  const objectLiteral = extractExportObjectLiteral(source, exportName);
  if (!objectLiteral) return {};
  try {
    return JSON.parse(objectLiteral);
  } catch {
    try {
      return new Function(`return ${objectLiteral}`)();
    } catch {
      return {};
    }
  }
}

function findExportConstStart(source, exportName) {
  const marker = `export const ${exportName}`;
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) return -1;
    const nextChar = source[start + marker.length];
    if (!nextChar || !/[\w$]/.test(nextChar)) return start;
    searchFrom = start + marker.length;
  }
  return -1;
}

/**
 * 提取 `export const name ... = { ... }` 的对象字面量。
 * 必须跳过 TypeScript 类型注解里的 `{ }`（如 Record<string, Foo & { x?: number }>），
 * 否则会误解析成 `{ x?: number }`，缓存永远读空、同步会冲掉已有 ASIN。
 * 同时须精确匹配 export 名，避免 listingImageRemarks 命中 listingImageRemarksMeta。
 */
function extractExportObjectLiteral(source, exportName) {
  const start = findExportConstStart(source, exportName);
  if (start === -1) return null;

  const assignMatch = source.slice(start).match(/=\s*\{/);
  if (!assignMatch || assignMatch.index == null) return null;
  const braceStart = start + assignMatch.index + assignMatch[0].lastIndexOf("{");

  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, index + 1);
    }
  }
  return null;
}

/** 提取 `export const name ... = [ ... ]` 的数组字面量 */
export function extractExportArrayLiteral(source, exportName) {
  const start = findExportConstStart(source, exportName);
  if (start === -1) return null;

  const assignMatch = source.slice(start).match(/=\s*\[/);
  if (!assignMatch || assignMatch.index == null) return null;
  const bracketStart = start + assignMatch.index + assignMatch[0].lastIndexOf("[");

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = bracketStart; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(bracketStart, index + 1);
    }
  }
  return null;
}

export function readCachedArrayExport(filePath, exportName) {
  if (!fs.existsSync(filePath)) return [];
  const source = fs.readFileSync(filePath, "utf8");
  const arrayLiteral = extractExportArrayLiteral(source, exportName);
  if (!arrayLiteral) return [];
  try {
    const parsed = JSON.parse(arrayLiteral);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function logCacheHit(asin, record) {
  const parts = [`[cache] ${asin}`];
  if (record.sampledReviews != null) parts.push(`${record.sampledReviews} reviews`);
  if (record.mentionTopics != null) parts.push(`${record.mentionTopics} topics`);
  if (record.volume?.length) parts.push(`${record.volume.length} months`);
  parts.push(`· ${record.fetchedAt ?? "cached"}`);
  console.log(parts.join(" · "));
}
export function isRepairIncomplete() {
  return process.env.AGENT_SYNC_REPAIR_INCOMPLETE === "1";
}

export function hasCompleteKeywordRecord(record) {
  return Boolean(record?.status === "ready" && Array.isArray(record.keywords)
    && record.keywords.some(row => typeof row?.keyword === "string" && row.keyword.trim()));
}

export function hasCompleteReviewRecord(record, verifiedEmpty = false) {
  return record?.status === "ready" && Boolean((Array.isArray(record.blocks) && record.blocks.some(block => Array.isArray(block?.rows) && block.rows.length > 0)) ||
    (verifiedEmpty && record.sampledReviews === 0 && Array.isArray(record.blocks) && record.blocks.length === 0));
}

export function hasUsableTrendRecord(record) {
  return record?.status === "ready" && ["volume", "amount", "price", "rank"].some(key =>
    Array.isArray(record[key]) && record[key].some(point => /^\d{4}-\d{2}$/.test(String(point?.month ?? "")) && Number.isFinite(point?.value) && point.value >= 0));
}

/** Preserve the original record, including its timestamp/provenance, if repair cannot replace it completely. */
export function createRepairSafeRecordMap(existing, { repair = isRepairIncomplete(), onPreserve = reportIncompleteRepair } = {}) {
  const records = { ...existing };
  if (!repair) return records;
  const metadata = new Set(["status", "statusMessage", "fetchedAt", "provenance", "provenanceByAsin", "terminalReason", "errorCode", "observationErrors"]);
  function losesContent(old, next) {
    if (Array.isArray(old)) return old.length > 0 && (!Array.isArray(next) || !next.length);
    if (old && typeof old === "object" && next && typeof next === "object") {
      return Object.entries(old).some(([field, value]) => !metadata.has(field) && losesContent(value, next[field]));
    }
    return old != null && old !== "" && (next == null || next === "");
  }
  return new Proxy(records, {
    set(target, key, value) {
      const previous = target[key];
      // A validated empty provider response remains pending for business readiness,
      // but is a successful observation needed by the bounded review fallback.
      const validEmpty = value?.status === "pending" && value.terminalReason === "valid-empty"
        && value.sampledReviews === 0 && value.mentionTopics === 0
        && Array.isArray(value.blocks) && value.blocks.every(block => Array.isArray(block?.rows) && block.rows.length === 0);
      const clearsReviewEvidence = validEmpty && ((previous?.sampledReviews ?? 0) > 0 || (previous?.mentionTopics ?? 0) > 0
        || (Array.isArray(previous?.blocks) && previous.blocks.some(block => Array.isArray(block?.rows) && block.rows.length > 0)));
      const failed = value?.status && !["ready", "empty"].includes(value.status) && !validEmpty;
      if (previous && (failed || clearsReviewEvidence || losesContent(previous, value))) onPreserve(key);
      else target[key] = value;
      return true;
    },
    deleteProperty(target, key) {
      if (Object.hasOwn(target, key)) { onPreserve(key); return true; }
      return Reflect.deleteProperty(target, key);
    },
  });
}

export function reportIncompleteRepair(key) {
  const stage = process.env.AGENT_SYNC_STAGE_ID ?? "unknown";
  const connector = ["keywords", "traffic"].includes(stage) ? "sif" : "sorftime";
  const asins = /^[A-Z0-9]{10}$/.test(String(key)) ? [String(key)]
    : (process.env.SORFTIME_ASINS ?? process.env.SIF_ASINS ?? "").split(",").map(asin => asin.trim()).filter(Boolean);
  console.error(`[repair-incomplete] ${String(key)} · replacement incomplete; retained prior cached portions`);
  for (const asin of asins) console.error(formatProviderDiagnosticLine({connector, stage, asin, failureKind:"schema", causeCode:"MCP_SCHEMA", boundary:"consumer-shape"}));
  process.exitCode = 1;
}
