import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RECOVERY_EXPORT_SPECS = Object.freeze([
  Object.freeze({ file: "competitor-data.ts", exportName: "refreshedCatalog", kind: "array", coverage: "catalog" }),
  Object.freeze({ file: "sif-keyword-analysis-data.ts", exportName: "sifKeywordAnalysisData", kind: "record", coverage: "sifKeyword" }),
  Object.freeze({ file: "sif-keyword-enrichment-data.ts", exportName: "sifKeywordEnrichmentData", kind: "enrichment", coverage: "sifEnrichment" }),
  Object.freeze({ file: "sif-listing-traffic-raw-data.ts", exportName: "sifListingTrafficRawByAsin", kind: "record", coverage: "sifListingTraffic" }),
  Object.freeze({ file: "sif-monthly-traffic-trend-raw-data.ts", exportName: "sifMonthlyTrafficRawByAsin", kind: "record", coverage: "sifMonthlyTraffic" }),
  Object.freeze({ file: "sorftime-review-analysis-data.ts", exportName: "sorftimeReviewAnalysisData", kind: "record", coverage: "sorftimeReview" }),
  Object.freeze({ file: "sorftime-rating-data.ts", exportName: "sorftimeRatingData", kind: "record", coverage: "sorftimeRating" }),
]);

export const EXCLUDED_RECOVERY_MODULES = Object.freeze([
  "sales (old business status remains missing)",
  "child sales",
  "price strategy",
  "FBA",
  "category trend",
  "listing content",
  "listing images and image remarks",
  "variant",
  "VOC",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertUniqueStrings(values, name) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`Invalid ${name}`);
  }
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}`);
}

function initializerRange(source, exportName, expectedOpening) {
  const marker = `export const ${exportName}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing export ${exportName}`);
  const next = source[start + marker.length];
  if (next && /[\w$]/.test(next)) throw new Error(`Ambiguous export ${exportName}`);
  const equals = source.indexOf("=", start + marker.length);
  if (equals < 0) throw new Error(`Missing initializer for ${exportName}`);
  let opening = equals + 1;
  while (/\s/.test(source[opening] ?? "")) opening += 1;
  if (source[opening] !== expectedOpening) throw new Error(`Invalid initializer for ${exportName}`);

  const expectedClosing = expectedOpening === "[" ? "]" : "}";
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === expectedOpening) depth += 1;
    else if (char === expectedClosing) {
      depth -= 1;
      if (depth === 0) return { opening, end: index + 1 };
    }
  }
  throw new Error(`Unterminated initializer for ${exportName}`);
}

function parseExport(source, spec) {
  const opening = spec.kind === "array" ? "[" : "{";
  const range = initializerRange(source, spec.exportName, opening);
  let value;
  try {
    value = JSON.parse(source.slice(range.opening, range.end));
  } catch (error) {
    throw new Error(`Invalid JSON initializer for ${spec.exportName}`, { cause: error });
  }
  if (spec.kind === "array") {
    if (!Array.isArray(value)) throw new Error(`Invalid array export ${spec.exportName}`);
  } else if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid record export ${spec.exportName}`);
  }
  return { value, range };
}

function replaceExport(source, spec, value) {
  const { range } = parseExport(source, spec);
  return `${source.slice(0, range.opening)}${JSON.stringify(value, null, 2)}${source.slice(range.end)}`;
}

function catalogRecordMap(records, label) {
  const result = new Map();
  for (const record of records) {
    const asin = record?.asin;
    if (typeof asin !== "string" || !asin) throw new Error(`Invalid ASIN in ${label}`);
    if (result.has(asin)) throw new Error(`Duplicate ASIN ${asin} in ${label}`);
    result.set(asin, record);
  }
  return result;
}

function selectedAsinRecords(value, kind, targetAsins, label) {
  if (kind === "array") {
    const map = catalogRecordMap(value, label);
    return new Map(targetAsins.filter((asin) => map.has(asin)).map((asin) => [asin, map.get(asin)]));
  }
  return new Map(targetAsins.filter((asin) => Object.hasOwn(value, asin)).map((asin) => [asin, value[asin]]));
}

function recordCount(value) {
  return Array.isArray(value) ? value.length : Object.keys(value).length;
}

function mergeSelected(currentValue, spec, selected) {
  const insertedKeys = [];
  const preservedKeys = [];
  if (spec.kind === "array") {
    const currentMap = catalogRecordMap(currentValue, `canonical ${spec.file}`);
    const output = [...currentValue];
    for (const [key, record] of selected) {
      if (currentMap.has(key)) preservedKeys.push(key);
      else {
        output.push(record);
        currentMap.set(key, record);
        insertedKeys.push(key);
      }
    }
    return { output, insertedKeys, preservedKeys, postKeys: currentMap };
  }
  const output = { ...currentValue };
  for (const [key, record] of selected) {
    if (Object.hasOwn(output, key)) preservedKeys.push(key);
    else {
      output[key] = record;
      insertedKeys.push(key);
    }
  }
  return { output, insertedKeys, preservedKeys, postKeys: new Map(Object.entries(output)) };
}

function keywordReferences(keywordData, targetAsins) {
  const references = [];
  const seen = new Set();
  for (const asin of targetAsins) {
    const record = keywordData[asin];
    for (const row of record?.keywords ?? []) {
      const keyword = row?.keyword;
      if (typeof keyword !== "string" || !keyword || seen.has(keyword)) continue;
      seen.add(keyword);
      references.push(keyword);
    }
  }
  return references;
}

function baselineRecords(value, spec, baselineAsins) {
  if (spec.kind === "enrichment") return null;
  return Object.fromEntries(selectedAsinRecords(value, spec.kind, baselineAsins, spec.file));
}

function digestBaseline(entries, side) {
  const value = Object.fromEntries(entries
    .filter((entry) => entry.spec.kind !== "enrichment")
    .map((entry) => [entry.file, baselineRecords(side === "before" ? entry.currentValue : entry.outputValue, entry.spec, entry.baselineAsins)]));
  return sha256(JSON.stringify(value));
}

function manifestEntryForFile(manifest, backupRoot, spec) {
  const matches = manifest.entries?.filter((entry) => entry?.category === "git-dirty"
    && path.basename(entry.backupPath ?? "") === spec.file) ?? [];
  if (matches.length !== 1) throw new Error(`Missing sealed manifest entry for ${spec.file}`);
  const entry = matches[0];
  const backupPath = path.resolve(entry.backupPath);
  if (!isWithin(backupRoot, backupPath)) throw new Error(`Backup path escapes sealed root for ${spec.file}`);
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error(`Invalid sealed SHA-256 for ${spec.file}`);
  return { entry, backupPath };
}

export function planGeneratedDataRecovery({ backupRoot: inputBackupRoot, canonicalRoot: inputCanonicalRoot, targetAsins, baselineAsins }) {
  assertUniqueStrings(targetAsins, "target ASINs");
  assertUniqueStrings(baselineAsins, "baseline ASINs");
  const backupRoot = path.resolve(inputBackupRoot);
  const canonicalRoot = path.resolve(inputCanonicalRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, "manifest.json"), "utf8"));
  const loaded = [];

  for (const spec of RECOVERY_EXPORT_SPECS) {
    const { entry: sourceEntry, backupPath } = manifestEntryForFile(manifest, backupRoot, spec);
    const backupSource = fs.readFileSync(backupPath, "utf8");
    if (sha256(backupSource) !== sourceEntry.sha256) throw new Error(`SHA-256 mismatch for ${spec.file}`);
    const canonicalPath = path.resolve(canonicalRoot, "app", spec.file);
    if (!isWithin(canonicalRoot, canonicalPath)) throw new Error(`Canonical path escapes root for ${spec.file}`);
    const canonicalSource = fs.readFileSync(canonicalPath, "utf8");
    loaded.push({
      spec,
      file: spec.file,
      baselineAsins,
      canonicalPath,
      backupValue: parseExport(backupSource, spec).value,
      currentValue: parseExport(canonicalSource, spec).value,
      canonicalSource,
      canonicalSourceSha256: sha256(canonicalSource),
      sourceEntry,
    });
  }

  const keywordEntry = loaded.find((entry) => entry.spec.coverage === "sifKeyword");
  const keywordSelection = selectedAsinRecords(
    keywordEntry.backupValue,
    keywordEntry.spec.kind,
    targetAsins,
    `backup ${keywordEntry.file}`,
  );
  const missingKeywordAsins = targetAsins.filter((asin) => !keywordSelection.has(asin));
  if (missingKeywordAsins.length) {
    throw new Error(`${keywordEntry.file} missing requested keys: ${missingKeywordAsins.join(", ")}`);
  }
  const effectiveKeywordData = mergeSelected(keywordEntry.currentValue, keywordEntry.spec, keywordSelection).output;
  const enrichmentKeys = keywordReferences(effectiveKeywordData, targetAsins);
  const planned = loaded.map((entry) => {
    const selectedKeys = entry.spec.kind === "enrichment" ? enrichmentKeys : targetAsins;
    const selected = entry.spec.kind === "enrichment"
      ? new Map(selectedKeys.filter((key) => Object.hasOwn(entry.backupValue, key)).map((key) => [key, entry.backupValue[key]]))
      : selectedAsinRecords(entry.backupValue, entry.spec.kind, targetAsins, `backup ${entry.file}`);
    const missing = selectedKeys.filter((key) => !selected.has(key));
    if (missing.length) throw new Error(`${entry.file} missing requested keys: ${missing.join(", ")}`);
    const merged = mergeSelected(entry.currentValue, entry.spec, selected);
    return {
      ...entry,
      selectedKeys,
      insertedKeys: merged.insertedKeys,
      preservedKeys: merged.preservedKeys,
      outputValue: merged.output,
      outputSource: replaceExport(entry.canonicalSource, entry.spec, merged.output),
      postKeys: merged.postKeys,
    };
  });

  const beforeDigest = digestBaseline(planned, "before");
  const afterDigest = digestBaseline(planned, "after");
  if (beforeDigest !== afterDigest) throw new Error("Canonical shelf-light baseline changed during recovery planning");
  const coverage = Object.fromEntries(planned.map((entry) => {
    const covered = entry.selectedKeys.filter((key) => entry.postKeys.has(key)).length;
    return [entry.spec.coverage, `${covered}/${entry.selectedKeys.length}`];
  }));
  const recoveryManifest = {
    version: 1,
    source: { backupRoot, gitHead: manifest.gitHead },
    targetAsins: [...targetAsins],
    exports: planned.map((entry) => ({
      file: `app/${entry.file}`,
      exportName: entry.spec.exportName,
      sourceSha256: entry.sourceEntry.sha256,
      preCount: recordCount(entry.currentValue),
      selectedCount: entry.selectedKeys.length,
      insertedCount: entry.insertedKeys.length,
      preservedCount: entry.preservedKeys.length,
      postCount: recordCount(entry.outputValue),
      records: entry.spec.kind === "enrichment"
        ? targetAsins.map((asin) => {
            const references = keywordReferences({ [asin]: effectiveKeywordData[asin] }, [asin]);
            return {
              asin,
              referencedCount: references.length,
              coveredCount: references.filter((keyword) => entry.postKeys.has(keyword)).length,
            };
          })
        : targetAsins.map((asin) => ({
            asin,
            outcome: entry.insertedKeys.includes(asin) ? "inserted" : "preserved-canonical",
          })),
    })),
    coverage,
    baseline: { asins: [...baselineAsins], beforeDigest, afterDigest },
    excludedModules: [...EXCLUDED_RECOVERY_MODULES],
    publicationAssessment: {
      durableSource: "committed canonical generated exports",
      currentLauncherStorage: "worktree-local data/web-runtime-artifacts",
      decision: "do not weaken the launcher's worktree containment invariant in this bounded recovery",
    },
  };
  return Object.freeze({ entries: planned, manifest: recoveryManifest });
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode : 0o600;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readExistingRecoveryManifest(manifestPath, expected) {
  if (!fs.existsSync(manifestPath)) return null;
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("Existing recovery manifest is invalid", { cause: error });
  }
  const exportsMatch = Array.isArray(existing.exports)
    && existing.exports.length === expected.exports.length
    && expected.exports.every((entry, index) => {
      const actual = existing.exports[index];
      return actual?.file === entry.file
        && actual?.exportName === entry.exportName
        && actual?.sourceSha256 === entry.sourceSha256;
    });
  const baselineMatches = sameJson(existing.baseline?.asins, expected.baseline.asins)
    && existing.baseline?.beforeDigest === existing.baseline?.afterDigest
    && existing.baseline?.afterDigest === expected.baseline.beforeDigest;
  if (
    existing.version !== expected.version
    || existing.source?.backupRoot !== expected.source.backupRoot
    || existing.source?.gitHead !== expected.source.gitHead
    || !sameJson(existing.targetAsins, expected.targetAsins)
    || !exportsMatch
    || !sameJson(existing.coverage, expected.coverage)
    || !baselineMatches
    || !sameJson(existing.excludedModules, expected.excludedModules)
  ) throw new Error("Existing recovery manifest does not match the requested recovery");
  return existing;
}

export function applyGeneratedDataRecovery(plan, { manifestPath, beforeWrite } = {}) {
  if (!plan?.entries || !plan?.manifest || typeof manifestPath !== "string" || !manifestPath) {
    throw new Error("Invalid generated-data recovery application");
  }
  if (beforeWrite !== undefined && typeof beforeWrite !== "function") {
    throw new Error("Invalid generated-data recovery write hook");
  }
  function assertCanonicalSourcesUnchanged() {
    for (const entry of plan.entries) {
      const currentSource = fs.readFileSync(entry.canonicalPath, "utf8");
      if (sha256(currentSource) !== entry.canonicalSourceSha256) {
        throw new Error(`Canonical source changed after recovery planning: ${entry.file}`);
      }
    }
  }
  assertCanonicalSourcesUnchanged();
  const resolvedManifestPath = path.resolve(manifestPath);
  const existing = readExistingRecoveryManifest(resolvedManifestPath, plan.manifest);
  const entriesToWrite = plan.entries.filter((entry) => entry.insertedKeys.length > 0);
  if (existing && entriesToWrite.length === 0) {
    return Object.freeze({ alreadyApplied: true, repairedDrift: false, manifest: existing });
  }
  beforeWrite?.();
  assertCanonicalSourcesUnchanged();
  for (const entry of entriesToWrite) {
    const currentSource = fs.readFileSync(entry.canonicalPath, "utf8");
    if (sha256(currentSource) !== entry.canonicalSourceSha256) {
      throw new Error(`Canonical source changed after recovery planning: ${entry.file}`);
    }
    atomicWrite(entry.canonicalPath, entry.outputSource);
  }
  if (!existing) atomicWrite(resolvedManifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);
  return Object.freeze({ alreadyApplied: false, repairedDrift: Boolean(existing), manifest: existing ?? plan.manifest });
}
