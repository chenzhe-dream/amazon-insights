import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXCLUDED_RECOVERY_MODULES,
  RECOVERY_EXPORT_SPECS,
  applyGeneratedDataRecovery,
  planGeneratedDataRecovery,
} from "../../scripts/lib/generated-data-recovery.mjs";

const TARGETS = ["LIGHT-A", "LIGHT-B"];
const BASELINE = ["SHELF-A"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exportSource(exportName, value) {
  return `// fixture\nexport type Fixture = { value?: string };\nexport const ${exportName}: Record<string, Fixture> = ${JSON.stringify(value, null, 2)};\n`;
}

function catalogSource(value) {
  return `// fixture\nexport const refreshedCatalog = ${JSON.stringify(value, null, 2)};\n`;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-recovery-"));
  const backupRoot = path.join(root, "backup");
  const canonicalRoot = path.join(root, "canonical");
  fs.mkdirSync(path.join(backupRoot, "git-dirty", "app"), { recursive: true });
  fs.mkdirSync(path.join(canonicalRoot, "app"), { recursive: true });

  const backupValues = {
    "competitor-data.ts": [
      { asin: "LIGHT-A", value: "backup-a" },
      { asin: "LIGHT-B", value: "backup-b" },
      { asin: "OUTSIDE", value: "not-selected" },
    ],
    "sif-keyword-analysis-data.ts": {
      "LIGHT-A": { asin: "LIGHT-A", keywords: [{ keyword: "k1" }, { keyword: "k2" }] },
      "LIGHT-B": { asin: "LIGHT-B", keywords: [{ keyword: "k2" }] },
      OUTSIDE: { asin: "OUTSIDE", keywords: [{ keyword: "k3" }] },
    },
    "sif-keyword-enrichment-data.ts": {
      k1: { value: "backup-k1" },
      k2: { value: "backup-k2" },
      k3: { value: "not-selected" },
    },
    "sif-listing-traffic-raw-data.ts": {
      "LIGHT-A": { value: "backup-a" }, "LIGHT-B": { value: "backup-b" }, OUTSIDE: { value: "not-selected" },
    },
    "sif-monthly-traffic-trend-raw-data.ts": {
      "LIGHT-A": { value: "backup-a" }, "LIGHT-B": { value: "backup-b" }, OUTSIDE: { value: "not-selected" },
    },
    "sorftime-review-analysis-data.ts": {
      "LIGHT-A": { value: "backup-a" }, "LIGHT-B": { value: "backup-b" }, OUTSIDE: { value: "not-selected" },
    },
    "sorftime-rating-data.ts": {
      "LIGHT-A": { value: "backup-a" }, "LIGHT-B": { value: "backup-b" }, OUTSIDE: { value: "not-selected" },
    },
  };
  const canonicalValues = {
    "competitor-data.ts": [
      { asin: "LIGHT-B", value: "canonical-b" },
      { asin: "SHELF-A", value: "canonical-shelf" },
    ],
    "sif-keyword-analysis-data.ts": {
      "LIGHT-B": { asin: "LIGHT-B", keywords: [{ keyword: "k2" }], value: "canonical-keyword-record" },
      "SHELF-A": { value: "canonical-shelf" },
    },
    "sif-keyword-enrichment-data.ts": { k2: { value: "canonical-k2" }, shelf: { value: "canonical-shelf" } },
    "sif-listing-traffic-raw-data.ts": { "LIGHT-B": { value: "canonical-b" }, "SHELF-A": { value: "canonical-shelf" } },
    "sif-monthly-traffic-trend-raw-data.ts": { "LIGHT-B": { value: "canonical-b" }, "SHELF-A": { value: "canonical-shelf" } },
    "sorftime-review-analysis-data.ts": { "LIGHT-B": { value: "canonical-b" }, "SHELF-A": { value: "canonical-shelf" } },
    "sorftime-rating-data.ts": { "LIGHT-B": { value: "canonical-b" }, "SHELF-A": { value: "canonical-shelf" } },
  };

  const entries = [];
  for (const spec of RECOVERY_EXPORT_SPECS) {
    const backupValue = backupValues[spec.file];
    const canonicalValue = canonicalValues[spec.file];
    const backupSource = spec.kind === "array"
      ? catalogSource(backupValue)
      : exportSource(spec.exportName, backupValue);
    const canonicalSource = spec.kind === "array"
      ? catalogSource(canonicalValue)
      : exportSource(spec.exportName, canonicalValue);
    const backupPath = path.join(backupRoot, "git-dirty", "app", spec.file);
    fs.writeFileSync(backupPath, backupSource, "utf8");
    fs.writeFileSync(path.join(canonicalRoot, "app", spec.file), canonicalSource, "utf8");
    entries.push({ category: "git-dirty", backupPath, sha256: sha256(backupSource), bytes: Buffer.byteLength(backupSource) });
  }
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), JSON.stringify({ gitHead: "fixture", entries }), "utf8");
  return { root, backupRoot, canonicalRoot };
}

test("plans exact target records, referenced enrichment, and canonical-wins collisions", () => {
  const fixture = makeFixture();
  try {
    const plan = planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    });
    const byFile = Object.fromEntries(plan.entries.map((entry) => [entry.file, entry]));

    assert.deepEqual(byFile["competitor-data.ts"].insertedKeys, ["LIGHT-A"]);
    assert.deepEqual(byFile["competitor-data.ts"].preservedKeys, ["LIGHT-B"]);
    assert.deepEqual(byFile["sif-keyword-enrichment-data.ts"].selectedKeys, ["k1", "k2"]);
    assert.deepEqual(byFile["sif-keyword-enrichment-data.ts"].insertedKeys, ["k1"]);
    assert.deepEqual(byFile["sif-keyword-enrichment-data.ts"].preservedKeys, ["k2"]);
    assert.equal(byFile["sif-keyword-enrichment-data.ts"].outputSource.includes("not-selected"), false);
    assert.deepEqual(plan.manifest.coverage, {
      catalog: "2/2",
      sifKeyword: "2/2",
      sifEnrichment: "2/2",
      sifListingTraffic: "2/2",
      sifMonthlyTraffic: "2/2",
      sorftimeReview: "2/2",
      sorftimeRating: "2/2",
    });
    assert.deepEqual(plan.manifest.excludedModules, EXCLUDED_RECOVERY_MODULES);
    assert.equal(plan.manifest.baseline.beforeDigest, plan.manifest.baseline.afterDigest);
    assert.deepEqual(plan.manifest.exports[0].records, [
      { asin: "LIGHT-A", outcome: "inserted" },
      { asin: "LIGHT-B", outcome: "preserved-canonical" },
    ]);
    assert.deepEqual(plan.manifest.exports[2].records, [
      { asin: "LIGHT-A", referencedCount: 2, coveredCount: 2 },
      { asin: "LIGHT-B", referencedCount: 1, coveredCount: 1 },
    ]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("applies semantic export replacements without overwriting canonical records", () => {
  const fixture = makeFixture();
  try {
    const plan = planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    });
    const manifestPath = path.join(fixture.canonicalRoot, "docs", "recovery.json");
    applyGeneratedDataRecovery(plan, { manifestPath });
    const catalog = fs.readFileSync(path.join(fixture.canonicalRoot, "app", "competitor-data.ts"), "utf8");
    const enrichment = fs.readFileSync(path.join(fixture.canonicalRoot, "app", "sif-keyword-enrichment-data.ts"), "utf8");

    assert.match(catalog, /canonical-b/);
    assert.match(catalog, /canonical-shelf/);
    assert.match(catalog, /backup-a/);
    assert.doesNotMatch(catalog, /not-selected/);
    assert.match(enrichment, /canonical-k2/);
    assert.match(enrichment, /backup-k1/);
    assert.doesNotMatch(enrichment, /backup-k2/);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), plan.manifest);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a source SHA mismatch before any canonical write", () => {
  const fixture = makeFixture();
  try {
    const target = path.join(fixture.backupRoot, "git-dirty", "app", "competitor-data.ts");
    fs.appendFileSync(target, "// changed after seal\n", "utf8");
    const before = fs.readFileSync(path.join(fixture.canonicalRoot, "app", "competitor-data.ts"), "utf8");

    assert.throws(() => planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    }), /SHA-256 mismatch/);
    assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "app", "competitor-data.ts"), "utf8"), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects canonical changes after planning before writing any planned file", () => {
  const fixture = makeFixture();
  try {
    const plan = planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    });
    const firstPath = path.join(fixture.canonicalRoot, "app", "competitor-data.ts");
    const changedPath = path.join(fixture.canonicalRoot, "app", "sif-keyword-analysis-data.ts");
    const firstBefore = fs.readFileSync(firstPath, "utf8");

    assert.throws(
      () => applyGeneratedDataRecovery(plan, {
        manifestPath: path.join(fixture.canonicalRoot, "recovery.json"),
        beforeWrite() {
          fs.appendFileSync(changedPath, "// changed after preflight\n", "utf8");
        },
      }),
      /canonical source changed after recovery planning/i,
    );
    assert.equal(fs.readFileSync(firstPath, "utf8"), firstBefore);
    assert.equal(fs.existsSync(path.join(fixture.canonicalRoot, "recovery.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when a preserved canonical keyword record references unavailable enrichment", () => {
  const fixture = makeFixture();
  try {
    const keywordSpec = RECOVERY_EXPORT_SPECS.find((spec) => spec.exportName === "sifKeywordAnalysisData");
    fs.writeFileSync(
      path.join(fixture.canonicalRoot, "app", keywordSpec.file),
      exportSource(keywordSpec.exportName, {
        "LIGHT-B": { asin: "LIGHT-B", keywords: [{ keyword: "canonical-only" }] },
        "SHELF-A": { value: "canonical-shelf" },
      }),
      "utf8",
    );
    assert.throws(() => planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    }), /enrichment.*missing requested keys/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a repeated apply preserves the first recovery audit manifest byte-for-byte", () => {
  const fixture = makeFixture();
  try {
    const manifestPath = path.join(fixture.canonicalRoot, "docs", "recovery.json");
    const firstPlan = planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    });
    applyGeneratedDataRecovery(firstPlan, { manifestPath });
    const firstAudit = fs.readFileSync(manifestPath, "utf8");
    const secondPlan = planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    });

    const result = applyGeneratedDataRecovery(secondPlan, { manifestPath });
    assert.equal(result.alreadyApplied, true);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), firstAudit);
    assert.equal(result.manifest.exports[0].insertedCount, 1);
    assert.equal(result.manifest.exports[0].preservedCount, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an existing audit does not suppress repair when a recovered record goes missing again", () => {
  const fixture = makeFixture();
  try {
    const manifestPath = path.join(fixture.canonicalRoot, "docs", "recovery.json");
    const firstPlan = planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    });
    applyGeneratedDataRecovery(firstPlan, { manifestPath });
    const firstAudit = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(
      path.join(fixture.canonicalRoot, "app", "competitor-data.ts"),
      catalogSource([
        { asin: "LIGHT-B", value: "canonical-b" },
        { asin: "SHELF-A", value: "canonical-shelf" },
      ]),
      "utf8",
    );
    const repairPlan = planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: TARGETS,
      baselineAsins: BASELINE,
    });

    const result = applyGeneratedDataRecovery(repairPlan, { manifestPath });
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.repairedDrift, true);
    assert.match(fs.readFileSync(path.join(fixture.canonicalRoot, "app", "competitor-data.ts"), "utf8"), /backup-a/);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), firstAudit);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refuses incomplete requested coverage and never plans unsupported modules", () => {
  const fixture = makeFixture();
  try {
    assert.throws(() => planGeneratedDataRecovery({
      backupRoot: fixture.backupRoot,
      canonicalRoot: fixture.canonicalRoot,
      targetAsins: [...TARGETS, "ABSENT"],
      baselineAsins: BASELINE,
    }), /missing requested keys/i);
    const files = RECOVERY_EXPORT_SPECS.map((spec) => spec.file).join(" ");
    for (const forbidden of ["sales", "child", "price", "fba", "category", "listing-content", "image", "variant", "voc"]) {
      assert.equal(files.includes(forbidden), false, forbidden);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
