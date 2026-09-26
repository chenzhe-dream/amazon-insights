import { ListingImagesSection } from "../listing-images-section";
import { colors } from "../project-report-views/competitor-overview";
import type { ImagesSnapshotSources } from "./read-page-snapshot-images";

/** All data is frozen at read time; no generated module defaults or analysis callbacks. */
export function PageSnapshotImages(props: ImagesSnapshotSources) {
  return <ListingImagesSection
    presentation="snapshot"
    products={props.products}
    market={props.market}
    colors={colors}
    listingByAsin={props.listingByAsin}
    resolveImageRemark={(asin, index) => props.remarksByAsin[asin]?.[index] ?? null}
    resolveImageOutcome={(asin, index) => {
      const outcome = props.outcomesByAsin[asin]?.[index];
      return outcome ? {status: outcome.status, reason: outcome.status} : null;
    }}
    resolveImageOverlay={(asin, index) => props.overlays.find(item => item.asin === asin && item.index === index) ?? null}
  />;
}
