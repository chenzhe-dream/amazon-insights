import fs from "node:fs";

/** 是否强制刷新（忽略缓存，重新调用 MCP） */
export function isForceRefresh() {
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
  if (forceRefresh) return false;
  if (!record || record.status !== "ready") return false;
  if (isCacheStale(record, maxAgeDays)) return false;
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
function extractExportArrayLiteral(source, exportName) {
  const start = findExportConstStart(source, exportName);
  if (start === -1) return null;

  const assignMatch = source.slice(start).match(/=\s*\[/);
  if (!assignMatch || assignMatch.index == null) return null;
  const bracketStart = start + assignMatch.index + assignMatch[0].lastIndexOf("[");

  let depth = 0;
  for (let index = bracketStart; index < source.length; index += 1) {
    const char = source[index];
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
