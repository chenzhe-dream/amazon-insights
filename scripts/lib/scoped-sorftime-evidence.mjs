import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getProjectRoot } from "./project-root.mjs";
import { resolveRuntimeRoots } from "./runtime-roots.mjs";
import { parseImageList } from "./sorftime-listing-parse.mjs";

const SCHEMA_VERSION = 1;
const SOURCE = "Sorftime";
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function evidenceRoot({ root, env = process.env } = {}) {
  if (root) return path.resolve(root);
  const codeRoot = getProjectRoot();
  return path.join(resolveRuntimeRoots({ codeRoot, env }).runtimeRoot, "sync-evidence", "sorftime");
}

function normalizedIdentity({ jobId, marketplace, asin, operation }) {
  const normalizedMarketplace = String(marketplace ?? "").trim().toUpperCase();
  const normalizedAsin = String(asin ?? "").trim().toUpperCase();
  if (!SAFE_ID_PATTERN.test(String(jobId ?? ""))) throw new TypeError("Sorftime evidence jobId invalid");
  if (!SAFE_ID_PATTERN.test(normalizedMarketplace)) throw new TypeError("Sorftime evidence marketplace invalid");
  if (!ASIN_PATTERN.test(normalizedAsin)) throw new TypeError("Sorftime evidence ASIN invalid");
  if (!SAFE_ID_PATTERN.test(String(operation ?? ""))) throw new TypeError("Sorftime evidence operation invalid");
  return { jobId: String(jobId), marketplace: normalizedMarketplace, asin: normalizedAsin, operation: String(operation) };
}

function evidencePath(identity, options) {
  return path.join(
    evidenceRoot(options),
    identity.jobId,
    identity.marketplace,
    identity.asin,
    `${identity.operation}.json`,
  );
}

function normalizeProductDetailData(data) {
  const galleryImages = parseImageList(data?.galleryImages ?? data?.main_image);
  const hasAplus = data?.hasAplus === true || data?.a_plus === true
    ? true
    : data?.hasAplus === false || data?.a_plus === false
      ? false
      : null;
  return { galleryImages, hasAplus };
}

export function createProductDetailEvidence({
  jobId,
  marketplace,
  asin,
  fetchedAt = new Date().toISOString(),
  detail,
}) {
  const identity = normalizedIdentity({ jobId, marketplace, asin, operation: "product_detail" });
  const normalizedFetchedAt = new Date(fetchedAt).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    ...identity,
    fetchedAt: normalizedFetchedAt,
    source: SOURCE,
    provenance: {
      connector: "sorftime",
      tool: "product_detail",
      stageId: "catalog",
    },
    data: normalizeProductDetailData(detail),
  };
}

export function writeScopedSorftimeEvidence(evidence, options = {}) {
  const identity = normalizedIdentity(evidence);
  if (evidence.schemaVersion !== SCHEMA_VERSION || evidence.source !== SOURCE) {
    throw new TypeError("Sorftime evidence envelope invalid");
  }
  const fetchedAt = new Date(evidence.fetchedAt).toISOString();
  const value = {
    schemaVersion: SCHEMA_VERSION,
    ...identity,
    fetchedAt,
    source: SOURCE,
    provenance: {
      connector: "sorftime",
      tool: identity.operation,
      stageId: evidence.provenance?.stageId === "catalog" ? "catalog" : "catalog",
    },
    data: identity.operation === "product_detail"
      ? normalizeProductDetailData(evidence.data)
      : {},
  };
  const target = evidencePath(identity, options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return value;
}

export function readScopedSorftimeEvidence(identityInput, options = {}) {
  const identity = normalizedIdentity(identityInput);
  const target = evidencePath(identity, options);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
  try {
    const parsedIdentity = normalizedIdentity(parsed);
    if (
      parsed.schemaVersion !== SCHEMA_VERSION
      || parsed.source !== SOURCE
      || Object.keys(identity).some(key => parsedIdentity[key] !== identity[key])
    ) return null;
    const fetchedAt = new Date(parsed.fetchedAt).toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      ...parsedIdentity,
      fetchedAt,
      source: SOURCE,
      provenance: {
        connector: "sorftime",
        tool: identity.operation,
        stageId: parsed.provenance?.stageId === "catalog" ? "catalog" : "catalog",
      },
      data: identity.operation === "product_detail"
        ? normalizeProductDetailData(parsed.data)
        : {},
    };
  } catch {
    return null;
  }
}
