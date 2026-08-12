import fs from "node:fs";
import path from "node:path";
import { canonicalTheme } from "./lib/voc-theme-merge.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "app", "competitor-data.ts");
const rufusPath = path.join(root, "app", "rufus-voc-data.ts");
const sorftimeReviewPath = path.join(root, "app", "sorftime-review-analysis-data.ts");
const salesPath = path.join(root, "app", "sorftime-sales-trend-data.ts");

function readExport(filePath, exportName) {
  const source = fs.readFileSync(filePath, "utf8");
  const pattern = new RegExp(`${exportName}[^=]*=\\s*(\\{[\\s\\S]*\\});?\\s*$`);
  const match = source.match(pattern);
  return match ? JSON.parse(match[1]) : {};
}

function readCatalog() {
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"[\s\S]*?"brand":\s*"([^"]+)"/g)].map(m => ({
    asin: m[1],
    brand: m[2],
  }));
}

const summaryKeys = ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"];

function themeWeight(entry, totalProducts) {
  if (entry.pcts.length) return entry.pcts.reduce((s, v) => s + v, 0);
  return entry.brands.size / totalProducts;
}

function addTheme(bucket, label, pct, brand, source, dimension) {
  const canonical = canonicalTheme(label, dimension);
  if (!canonical.key) return;
  const current = bucket.get(canonical.key) ?? {
    label: canonical.label,
    pcts: [],
    brands: new Set(),
    sources: new Set(),
  };
  if (pct != null && Number.isFinite(pct)) current.pcts.push(pct);
  current.brands.add(brand);
  current.sources.add(source);
  bucket.set(canonical.key, current);
}

function finalize(bucket, totalProducts) {
  const sorted = [...bucket.values()].sort((a, b) => themeWeight(b, totalProducts) - themeWeight(a, totalProducts));
  const total = sorted.reduce((s, e) => s + themeWeight(e, totalProducts), 0) || 1;
  return sorted.map(e => ({
    label: e.label,
    pct: (themeWeight(e, totalProducts) / total) * 100,
    brands: [...e.brands],
    sources: [...e.sources],
  }));
}

const products = readCatalog();
const rufus = readExport(rufusPath, "rufusVocData");
const sorftime = readExport(sorftimeReviewPath, "sorftimeReviewAnalysisData");
const sales = readExport(salesPath, "sorftimeSalesTrendData");

const blockMap = {
  consumerProfile: "audiences",
  scenarios: "scenarios",
  unmet: "unmet",
  positives: "positives",
  negatives: "negatives",
  motives: "motives",
};

const summaries = {};
for (const key of summaryKeys) {
  const bucket = new Map();
  for (const p of products) {
    const record = rufus[p.asin];
    if (record?.captureStatus === "dialog" && record[key]) {
      for (const line of record[key]) {
        if (typeof line !== "string" || line.includes("待在 Alexa")) continue;
        let label = line;
        if (key === "attention") label = line.match(/^\d+\.\s*(.+?)：/)?.[1] ?? line;
        else if (["positives", "negatives"].includes(key)) label = line.match(/【([^】]+)】/)?.[1] ?? line;
        else if (key === "unmet") label = line.replace(/^\d+\.\s*/, "").replace(/^希望/, "").split(/[，。]/)[0];
        else label = line.split("｜")[0];
        addTheme(bucket, label, null, p.brand, "VOC", key);
      }
    }
    const analysis = sorftime[p.asin];
    if (analysis?.status === "ready") {
      for (const block of analysis.blocks ?? []) {
        const dim = blockMap[block.key];
        if (dim !== key) continue;
        for (const row of block.rows ?? []) {
          addTheme(bucket, row.label, row.sharePct, p.brand, "Sorftime", key);
        }
      }
    }
  }
  summaries[key] = finalize(bucket, products.length);
}

console.log(JSON.stringify({ summaries, sales: Object.fromEntries(products.map(p => [p.asin, sales[p.asin]?.volume?.at(-1)])) }, null, 2));
