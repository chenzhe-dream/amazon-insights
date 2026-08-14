const KIND_SLUG = {
  analysis: "",
  "keyword-compare": "keywords",
  "traffic-promo": "traffic",
  checklist: "checklist",
};

const MARKET_SLUGS = new Set(["us", "uk", "de", "jp", "ca", "au", "fr", "it", "es", "mx"]);

export function slugify(value) {
  const ascii = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii;
}

export function isProjectSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value ?? ""));
}

export function marketplaceSlug(code) {
  const value = String(code ?? "US").trim().toLowerCase();
  return MARKET_SLUGS.has(value) ? value : "us";
}

export function projectSlugBase(project) {
  const label = slugify(project?.categoryLabel) || slugify(project?.name) || "project";
  const market = marketplaceSlug(project?.marketplace);
  const alias = slugify(project?.alias);
  const extra = alias && alias !== label && !alias.startsWith(`${label}-${market}`) ? alias.slice(0, 24) : "";
  const kindPart = KIND_SLUG[project?.kind] ?? "";
  return [label, market, extra, kindPart].filter(Boolean).join("-") || "project";
}

export function uniqueSlug(base, used) {
  const root = slugify(base) || "project";
  const taken = used instanceof Set ? used : new Set(used ?? []);
  if (!taken.has(root)) return root;
  let index = 2;
  while (taken.has(`${root}-${index}`)) index += 1;
  return `${root}-${index}`;
}
