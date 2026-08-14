export type ProductFamily = "scooter" | "lighting" | "generic";

export function detectProductFamily({
  title = "",
  category = "",
  features = [],
}: {
  title?: string;
  category?: string;
  features?: string[];
} = {}): ProductFamily {
  const text = [title, category, ...(Array.isArray(features) ? features : [])].join(" ").toLowerCase();
  if (/scooter|kick\s*scooter|滑板车/.test(text)) return "scooter";
  if (
    /\bfloor lamps?\b|\bshelf lamps?\b|\btable lamps?\b|\bstanding lamps?\b|\blighting\b|落地灯|台灯|置物架灯/.test(text) ||
    (/\blamps?\b|\blampshade\b|\bbulbs?\b/.test(text) && !/wheel|scooter|deck/.test(text))
  ) {
    return "lighting";
  }
  return "generic";
}

export function familyFromProducts(
  products: Array<{
    productFamily?: ProductFamily;
    title?: string;
    subRankCategory?: string;
    rankCategory?: string;
  }>
): ProductFamily {
  const explicit = products.map(item => item.productFamily).filter((item): item is ProductFamily => Boolean(item));
  if (explicit.length) {
    const lighting = explicit.filter(item => item === "lighting").length;
    const scooter = explicit.filter(item => item === "scooter").length;
    if (lighting >= scooter && lighting >= Math.ceil(explicit.length / 2)) return "lighting";
    if (scooter > lighting && scooter >= Math.ceil(explicit.length / 2)) return "scooter";
    if (explicit.every(item => item === "generic")) return "generic";
  }

  return detectProductFamily({
    title: products.map(item => item.title ?? "").join(" "),
    category: products.map(item => `${item.subRankCategory ?? ""} ${item.rankCategory ?? ""}`).join(" "),
  });
}
