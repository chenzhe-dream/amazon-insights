export type CatalogSource = "sellerSprite" | "sorftime-fallback";
export type CatalogFieldSources = Record<string, "sorftime">;

export function CatalogProfileValue({ product, field }: {
  product: { synced: boolean; catalogSource?: CatalogSource; catalogFieldSources?: CatalogFieldSources } & Record<string, unknown>;
  field: string;
}) {
  const primary = product.synced && product.catalogSource !== "sorftime-fallback";
  const verifiedFallback = !primary && product.catalogFieldSources?.[field] === "sorftime";
  const value = product[field];
  const available = (primary || verifiedFallback) && typeof value === "string" && value.trim() && !/^(—|-|null|等待同步|暂无数据)$/i.test(value.trim());
  return available ? <span className="catalog-profile-value">{value}{verifiedFallback ? <small className="insight-source">Sorftime · 商品参数</small> : null}</span> : <span className="no-data-text">{product.catalogSource === "sorftime-fallback" ? "Sorftime 未返回已核验参数" : "暂无数据"}</span>;
}

export function CatalogSourceStatus({
  product,
}: {
  product: { catalogSource?: CatalogSource; synced: boolean };
}) {
  const source = product.catalogSource ?? (product.synced ? "sellerSprite" : null);
  if (source === "sorftime-fallback") {
    return <em>Sorftime 基础数据 · SellerSprite 专属字段暂缺</em>;
  }
  if (source === "sellerSprite") {
    return <em>SellerSprite 已同步</em>;
  }
  return <em>等待同步</em>;
}
