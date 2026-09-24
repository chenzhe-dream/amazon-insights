import type { XydcVariantFamily } from "./xydc-variant-contract";

export type XydcVariantFamilyGroup = Readonly<{
  country: string;
  parentAsin: string;
  inputAsins: string[];
  dimensions: string[];
  children: XydcVariantFamily["children"];
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  status: XydcVariantFamily["status"];
  reasonCode: XydcVariantFamily["reasonCode"];
  cacheState: XydcVariantFamily["cacheState"];
}>;

type ChildCandidate = Readonly<{ child: XydcVariantFamily["children"][number]; family: XydcVariantFamily }>;

function timeValue(value: string | null) {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

function compareFamilies(left: XydcVariantFamily, right: XydcVariantFamily) {
  const sourceDifference = timeValue(right.sourceUpdatedAt) - timeValue(left.sourceUpdatedAt);
  if (sourceDifference) return sourceDifference;
  const fetchedDifference = timeValue(right.fetchedAt) - timeValue(left.fetchedAt);
  if (fetchedDifference) return fetchedDifference;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function childInfoRank(status: XydcVariantFamily["children"][number]["infoStatus"]) {
  return status === "ready" ? 2 : status === "pending" ? 1 : 0;
}

function compareChildCandidates(left: ChildCandidate, right: ChildCandidate) {
  const statusDifference = childInfoRank(left.child.infoStatus) - childInfoRank(right.child.infoStatus);
  if (statusDifference) return statusDifference;
  const familyDifference = compareFamilies(left.family, right.family);
  if (familyDifference) return -familyDifference;
  return JSON.stringify(right.child).localeCompare(JSON.stringify(left.child));
}

function mergeVariantFamilyGroup(families: readonly XydcVariantFamily[]): XydcVariantFamilyGroup {
  const orderedFamilies = [...families].sort(compareFamilies);
  const childByAsin = new Map<string, ChildCandidate>();
  for (const family of orderedFamilies) {
    for (const child of family.children) {
      const candidate = { child, family };
      const current = childByAsin.get(child.asin);
      if (!current || compareChildCandidates(candidate, current) > 0) childByAsin.set(child.asin, candidate);
    }
  }
  const inputAsins = [...new Set(orderedFamilies.map(family => family.inputAsin))].sort();
  const dimensions = [...new Set(orderedFamilies.flatMap(family => family.dimensions))].sort();
  const children = [...childByAsin.values()].map(candidate => candidate.child).sort((left, right) => left.asin.localeCompare(right.asin));
  const allUnavailable = families.every(family => family.status === "unavailable");
  const status = allUnavailable ? "unavailable" : families.some(family => family.status !== "ready") ? "partial" : "ready";
  const unavailable = orderedFamilies.find(family => family.status === "unavailable");
  const partial = orderedFamilies.find(family => family.status === "partial");
  const stale = orderedFamilies.find(family => family.cacheState === "stale");
  const metadataFamily = stale ?? orderedFamilies[0]!;
  return {
    country: orderedFamilies[0]!.country,
    parentAsin: orderedFamilies[0]!.parentAsin,
    inputAsins,
    dimensions,
    children,
    sourceUpdatedAt: metadataFamily.sourceUpdatedAt,
    fetchedAt: metadataFamily.fetchedAt,
    status,
    reasonCode: (status === "unavailable" ? unavailable : partial ?? unavailable)?.reasonCode ?? null,
    cacheState: families.some(family => family.cacheState === "stale") ? "stale" : "fresh",
  };
}

export function groupXydcVariantFamilies(families: readonly XydcVariantFamily[]) {
  const groups = new Map<string, XydcVariantFamily[]>();
  for (const family of families) {
    const key = `${family.country}:${family.parentAsin}`;
    groups.set(key, [...(groups.get(key) ?? []), family]);
  }
  return [...groups.values()].map(mergeVariantFamilyGroup).sort((left, right) =>
    `${left.country}:${left.parentAsin}`.localeCompare(`${right.country}:${right.parentAsin}`),
  );
}
