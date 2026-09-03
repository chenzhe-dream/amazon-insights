export type CatalogSource = "sellerSprite" | "sorftime-fallback";

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
