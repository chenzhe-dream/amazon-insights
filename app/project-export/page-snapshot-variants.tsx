import type {XydcOrderSnapshot} from "../../shared/xydc-order-contract";
import type {XydcOrderProgressView} from "../../shared/xydc-order-progress";
import type {XydcVariantFamily} from "../../shared/xydc-variant-contract";
import {XydcVariantSection, type XydcVariantMarket, type XydcVariantProduct} from "../xydc-variant-section";

export type VariantsSnapshotSources = Readonly<{
  products: readonly XydcVariantProduct[];
  families: readonly XydcVariantFamily[];
  orderFamilies: readonly XydcOrderSnapshot[];
  market: XydcVariantMarket;
  capturedAt: string;
  progress: XydcOrderProgressView | null;
}>;

export function PageSnapshotVariants(props: VariantsSnapshotSources) {
  return <XydcVariantSection {...props} presentation="snapshot"/>;
}
